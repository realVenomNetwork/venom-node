"""
quick_test_harness.py - lightweight manual smoke harness.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

from attackers import (
    AdvancedFundedAttacker,
    BasicRetailAttacker,
    FluentFillerAttacker,
    HonestBaselineAttacker,
    IntermediateSemiProAttacker,
    MechanicallyAwareAttacker,
)
from core.economics import EconomicConfig, compute_outcome
from core.epoch import EpochConfig, EpochManager
from core.evaluator_proxy import EvaluatorProxy, PromptSelector, ScoringEngine
from eval_harness.metrics import MetricsTracker
from eval_harness.report import format_report
from run_epoch import build_submission_id, infer_category, load_prompts


ATTACKER_REGISTRY = {
    "basic": BasicRetailAttacker,
    "intermediate": IntermediateSemiProAttacker,
    "advanced": AdvancedFundedAttacker,
    "honest": HonestBaselineAttacker,
    "fluent": FluentFillerAttacker,
    "mechanical": MechanicallyAwareAttacker,
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tier", choices=ATTACKER_REGISTRY.keys(), required=True)
    parser.add_argument("--days", type=int, default=1)
    parser.add_argument("--submissions-per-day", type=int, default=5)
    parser.add_argument("--burn", type=int, default=800)
    args = parser.parse_args()

    prompts_dir = Path(__file__).parent / "prompts"
    public = load_prompts(prompts_dir / "public.json")
    rotating = load_prompts(prompts_dir / "rotating.json")
    hidden = load_prompts(prompts_dir / "hidden.json")

    if not public:
        raise RuntimeError(
            f"No public prompts found at {prompts_dir / 'public.json'}. "
            f"Populate the prompts directory before running."
        )

    attacker_cls = ATTACKER_REGISTRY[args.tier]
    attacker = attacker_cls()
    attacker.config.submissions_per_day = args.submissions_per_day
    attacker.known_public_prompts = public
    attacker.known_rotating_prompts = rotating

    selector = PromptSelector(public, rotating, hidden)
    scorer = ScoringEngine()
    evaluator = EvaluatorProxy(selector, scorer)

    econ = EconomicConfig(
        base_reward=2000,
        burn_per_attempt=args.burn,
    )

    epoch_config = EpochConfig(duration_days=args.days)
    epoch_manager = EpochManager(epoch_config, {1: rotating})
    metrics = MetricsTracker()

    for day in range(1, args.days + 1):
        metrics.set_day(day)
        attacker.on_day_advance(day)
        epoch = epoch_manager.current_epoch

        for attempt_idx in range(attacker.config.submissions_per_day):
            submission_id = build_submission_id(
                attacker.config.name,
                day,
                attempt_idx,
                "",
            )

            selected = selector.select(submission_id, epoch=epoch)
            pattern_prefix = hashlib.sha256(selected[0].prompt[:50].encode()).hexdigest()[:12]
            effective_submission_id = pattern_prefix + submission_id[12:]

            report = evaluator.evaluate_submission(
                submission_id=effective_submission_id,
                epoch=epoch,
                output_generator=attacker.generate_output,
            )

            outcome = compute_outcome(
                submission_id=effective_submission_id,
                passed=report.passed,
                slashed=report.slashed,
                score=report.aggregate_score,
                config=econ,
            )

            categories = list(
                {
                    infer_category(p.prompt)
                    for p in selector.select(effective_submission_id, epoch)
                }
            )

            metrics.record(
                passed=report.passed,
                slashed=report.slashed,
                score=report.aggregate_score,
                net_ev=outcome.net_ev,
                prompt_categories=categories,
                component_averages=report.component_averages,
            )

            attacker.observe_result(
                submission_id=effective_submission_id,
                passed=report.passed,
                score=report.aggregate_score,
            )

    summary = metrics.summary()
    config_display = {
        "attacker_tier": args.tier,
        "submissions_per_day": attacker.config.submissions_per_day,
        "epoch_duration_days": args.days,
        "base_reward": econ.base_reward,
        "burn_per_attempt": econ.burn_per_attempt,
        "public_prompt_count": len(public),
        "rotating_prompt_count": len(rotating),
        "hidden_prompt_count": len(hidden),
        "adaptation_enabled": attacker.config.adaptation_enabled,
        "cross_epoch_memory": attacker.config.cross_epoch_memory,
    }
    print(format_report(attacker.config.name, summary, config_display))


if __name__ == "__main__":
    main()
