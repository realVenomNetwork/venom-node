"""
run_epoch.py — SDK entry point.

Usage:
    python run_epoch.py --tier basic       --days 7
    python run_epoch.py --tier intermediate --days 7
    python run_epoch.py --tier advanced    --days 7

The harness runs N days of simulated attacks against a local evaluator
proxy. It produces a full report with daily pass rate, cumulative EV,
and a final verdict (breach or secure).

IMPORTANT: This runs entirely off-chain. It does not touch any testnet
or mainnet. Populate the prompt pools in `prompts/` before running.
"""

import argparse
import hashlib
import json
from pathlib import Path

from core.evaluator_proxy import (
    EvaluatorProxy,
    PromptSelector,
    ScoringEngine,
    PromptSpec,
)
from core.economics import EconomicConfig, compute_outcome
from core.epoch import EpochConfig, EpochManager
from eval_harness.metrics import MetricsTracker
from eval_harness.report import format_report

from attackers import (
    AdvancedFundedAttacker,
    BasicRetailAttacker,
    FluentFillerAttacker,
    HonestBaselineAttacker,
    IntermediateSemiProAttacker,
    MechanicallyAwareAttacker,
)


ATTACKER_REGISTRY = {
    "basic":        BasicRetailAttacker,
    "intermediate": IntermediateSemiProAttacker,
    "advanced":     AdvancedFundedAttacker,
    "honest":       HonestBaselineAttacker,
    "fluent":       FluentFillerAttacker,
    "mechanical":   MechanicallyAwareAttacker,
}


def load_prompts(path: Path) -> list[PromptSpec]:
    """
    Load a prompt pool from JSON.
    Expected format: {"prompts": [ {...PromptSpec fields...}, ... ]}
    """
    if not path.exists():
        return []

    with open(path) as f:
        data = json.load(f)

    prompts_raw = data.get("prompts", data) if isinstance(data, dict) else data
    fixed = []
    for p in prompts_raw:
        q = dict(p)
        q.setdefault("reference_answer", "")
        fixed.append(PromptSpec(**q))
    return fixed


def build_submission_id(attacker_name: str, day: int, attempt: int, prompt_pattern_sig: str = "") -> str:
    """
    Generate a submission ID.
    First 12 chars encode a pattern signature (used by advanced attacker's memory).
    """
    raw = f"{attacker_name}:{day}:{attempt}:{prompt_pattern_sig}"
    h = hashlib.sha256(raw.encode()).hexdigest()
    return h[:64]


def infer_category(prompt: str) -> str:
    """Rough category classifier for metrics bucketing."""
    p = prompt.lower()
    if any(w in p for w in ["rewrite", "edit", "summarize", "rephrase", "make it"]):
        return "transformation"
    if any(w in p for w in ["explain why", "tradeoff", "compare", "reason", "decide"]):
        return "reasoning"
    return "applied"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tier", choices=ATTACKER_REGISTRY.keys(), required=True)
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--submissions-per-day", type=int, default=None,
                        help="Override default for tier")
    parser.add_argument("--prompts-dir", type=Path,
                        default=Path(__file__).parent / "prompts")
    parser.add_argument("--filler-bank", type=Path, default=None,
                        help="Optional contrastive filler bank JSON for candidate verification")
    parser.add_argument("--base-reward", type=int, default=2000)
    parser.add_argument("--burn", type=int, default=500)
    args = parser.parse_args()

    # Load prompt pools
    public   = load_prompts(args.prompts_dir / "public.json")
    rotating = load_prompts(args.prompts_dir / "rotating.json")
    hidden   = load_prompts(args.prompts_dir / "hidden.json")

    if not public:
        raise RuntimeError(
            f"No public prompts found at {args.prompts_dir / 'public.json'}. "
            f"Populate the prompts directory before running."
        )

    # Attacker
    attacker_cls = ATTACKER_REGISTRY[args.tier]
    attacker = attacker_cls()
    if args.submissions_per_day:
        attacker.config.submissions_per_day = args.submissions_per_day

    # Attacker learns what it's allowed to learn
    attacker.known_public_prompts = public
    attacker.known_rotating_prompts = rotating   # reveal at epoch 1 start

    # Evaluator
    selector = PromptSelector(public, rotating, hidden)
    scorer = ScoringEngine(filler_bank_path=args.filler_bank)
    evaluator = EvaluatorProxy(selector, scorer)

    # Economics
    econ = EconomicConfig(
        base_reward=args.base_reward,
        burn_per_attempt=args.burn,
    )

    # Epoch manager (single epoch for now; extend for multi-epoch runs)
    epoch_config = EpochConfig(duration_days=args.days)
    epoch_manager = EpochManager(epoch_config, {1: rotating})

    # Metrics
    metrics = MetricsTracker()

    # Main simulation loop
    for day in range(1, args.days + 1):
        metrics.set_day(day)
        attacker.on_day_advance(day)

        for attempt_idx in range(attacker.config.submissions_per_day):
            # Pattern signature pre-computation for advanced attacker
            # (harness computes it from prompts the attacker will see)
            pattern_sig = ""
            submission_id = build_submission_id(
                attacker.config.name, day, attempt_idx, pattern_sig,
            )

            # Inject pattern sig into submission id prefix for advanced attacker
            # by overriding the first 12 chars with a deterministic pattern
            # derived from the first prompt in the selection
            selected = selector.select(submission_id, epoch=1)
            pattern_prefix = hashlib.sha256(
                selected[0].prompt[:50].encode()
            ).hexdigest()[:12]
            effective_submission_id = pattern_prefix + submission_id[12:]

            # Run evaluation with attacker's generator
            report = evaluator.evaluate_submission(
                submission_id=effective_submission_id,
                epoch=1,
                output_generator=attacker.generate_output,
            )

            outcome = compute_outcome(
                submission_id=effective_submission_id,
                passed=report.passed,
                slashed=report.slashed,
                score=report.aggregate_score,
                config=econ,
            )

            # Categories for metrics bucketing
            cats = list({infer_category(p.prompt) for p in
                         [s for s in selector.select(effective_submission_id, 1)]})

            metrics.record(
                passed=report.passed,
                slashed=report.slashed,
                score=report.aggregate_score,
                net_ev=outcome.net_ev,
                prompt_categories=cats,
                component_averages=report.component_averages,   # ← v4 diagnostic
            )

            attacker.observe_result(
                submission_id=effective_submission_id,
                passed=report.passed,
                score=report.aggregate_score,
            )

    # Report
    summary = metrics.summary()
    config_display = {
        "attacker_tier": args.tier,
        "submissions_per_day": attacker.config.submissions_per_day,
        "epoch_duration_days": args.days,
        "base_reward": econ.base_reward,
        "burn_per_attempt": econ.burn_per_attempt,
        "filler_bank": str(scorer.filler_bank_path),
        "filler_bank_patterns": scorer.filler_bank_size,
        "contrastive_lambda": scorer.contrastive_lambda,
        "contrastive_rescale": scorer.contrastive_rescale,
        "public_prompt_count": len(public),
        "rotating_prompt_count": len(rotating),
        "hidden_prompt_count": len(hidden),
        "adaptation_enabled": attacker.config.adaptation_enabled,
        "cross_epoch_memory": attacker.config.cross_epoch_memory,
    }
    print(format_report(attacker.config.name, summary, config_display))


if __name__ == "__main__":
    main()
