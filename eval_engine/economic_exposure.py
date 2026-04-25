"""Registry-only economic exposure model for Phase 3A.

This script uses saved Attack B registry scores and explicit cost assumptions.
It does not run providers, scorers, embeddings, or network calls.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REGISTRY = REPO_ROOT / "attack_runs" / "attack_b_passfail_v51_real_001_registry.jsonl"
DEFAULT_OUT = REPO_ROOT / "docs" / "eval" / "PHASE3A_ECONOMIC_EXPOSURE.md"
DEFAULT_THRESHOLDS = (55, 60, 65, 70, 75)
DEFAULT_COSTS_USD = (0.00001, 0.00010, 0.00050, 0.00100, 0.00500)
DEFAULT_TOKEN_VALUES_USD = (0.00001, 0.00010, 0.00100)
DEFAULT_ATTEMPTS = (10, 1000, 10000)
DEFAULT_WORKER_ATTEMPTS = (1, 10, 100)
DEFAULT_FALSE_REJECTION_RATES = (0.01, 0.05, 0.10, 0.20)
DEFAULT_BURN_VRT = 800.0
DEFAULT_REWARD_VRT = 2000.0
DEFAULT_DAILY_CAP_VRT = 100000.0
DEFAULT_PER_WALLET_CAP_VRT = 10000.0
FALLBACK_PROMPTS = {"pub_005"}
REVIEW_CLASS_BY_PROMPT = {
    "pub_001": "topical and plausible",
    "pub_002": "topical and plausible",
    "pub_003": "topical but shallow",
    "pub_004": "topical but shallow",
    "pub_005": "fallback-confounded",
}


def resolve_path(path: Path) -> Path:
    if path.is_absolute():
        return path
    return (REPO_ROOT / path).resolve()


def relative(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path.resolve())


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    for line_no, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_no}: invalid JSONL row: {exc}") from exc
    return rows


def score(row: dict[str, Any]) -> int:
    return int(row["private_evaluation_not_returned_to_attacker"]["v5_1_score"])


def prompt_id(row: dict[str, Any]) -> str:
    return str(row.get("prompt_id", ""))


def parse_numbers(values: list[str] | None, default: tuple[float, ...]) -> list[float]:
    if not values:
        return list(default)
    parsed: list[float] = []
    for value in values:
        parsed.extend(float(part) for part in value.split(",") if part.strip())
    return sorted(set(parsed))


def parse_ints(values: list[str] | None, default: tuple[int, ...]) -> list[int]:
    if not values:
        return list(default)
    parsed: list[int] = []
    for value in values:
        parsed.extend(int(part) for part in value.split(",") if part.strip())
    return sorted(set(parsed))


def markdown_table(headers: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |"]
    out.append("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        clean = [cell.replace("\n", "<br>").replace("|", "\\|") for cell in row]
        out.append("| " + " | ".join(clean) + " |")
    return "\n".join(out)


def pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def money(value: float) -> str:
    if value and abs(value) < 0.000001:
        return f"${value:.2e}"
    if abs(value) < 0.01:
        return f"${value:.8f}"
    return f"${value:,.2f}"


def vrt(value: float) -> str:
    return f"{value:,.1f}"


def pass_rate(rows: list[dict[str, Any]], threshold: int) -> float:
    if not rows:
        return 0.0
    return sum(score(row) >= threshold for row in rows) / len(rows)


def net_vrt_per_attempt(pass_rate_value: float, *, burn_vrt: float, reward_vrt: float) -> float:
    return (pass_rate_value * reward_vrt) - burn_vrt


def fiat_ev_per_attempt(
    pass_rate_value: float,
    *,
    burn_vrt: float,
    reward_vrt: float,
    token_value_usd: float,
    inference_cost_usd: float,
) -> float:
    return (net_vrt_per_attempt(pass_rate_value, burn_vrt=burn_vrt, reward_vrt=reward_vrt) * token_value_usd) - inference_cost_usd


def honest_worker_net_vrt(false_rejection_rate: float, *, burn_vrt: float, reward_vrt: float) -> float:
    return ((1.0 - false_rejection_rate) * reward_vrt) - burn_vrt


def chance_at_least_one_false_rejection(false_rejection_rate: float, attempts: int) -> float:
    return 1.0 - ((1.0 - false_rejection_rate) ** attempts)


def breakeven_token_value(
    pass_rate_value: float,
    *,
    burn_vrt: float,
    reward_vrt: float,
    inference_cost_usd: float,
) -> str:
    token_ev = net_vrt_per_attempt(pass_rate_value, burn_vrt=burn_vrt, reward_vrt=reward_vrt)
    if token_ev <= 0:
        return "never profitable at positive VRT value"
    return money(inference_cost_usd / token_ev)


def grouped_rows(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[prompt_id(row)].append(row)
    return grouped


def prompt_range_for_threshold(by_prompt: dict[str, list[dict[str, Any]]], threshold: int) -> str:
    rates = [
        pass_rate(prompt_rows, threshold)
        for pid, prompt_rows in sorted(by_prompt.items())
        if pid not in FALLBACK_PROMPTS
    ]
    if not rates:
        return "n/a"
    return f"{pct(min(rates))}-{pct(max(rates))}"


def weakest_link_for_threshold(
    by_prompt: dict[str, list[dict[str, Any]]],
    threshold: int,
    *,
    burn_vrt: float,
    reward_vrt: float,
) -> list[str]:
    prompt_rates = [
        (pid, pass_rate(prompt_rows, threshold))
        for pid, prompt_rows in sorted(by_prompt.items())
        if pid not in FALLBACK_PROMPTS
    ]
    max_rate = max(rate for _, rate in prompt_rates)
    max_prompts = [pid for pid, rate in prompt_rates if rate == max_rate]
    max_net = net_vrt_per_attempt(max_rate, burn_vrt=burn_vrt, reward_vrt=reward_vrt)
    return [", ".join(max_prompts), pct(max_rate), vrt(max_net)]


def review_class_rate(rows: list[dict[str, Any]], threshold: int, label: str) -> float:
    selected = [
        row
        for row in rows
        if REVIEW_CLASS_BY_PROMPT.get(prompt_id(row)) == label
    ]
    return pass_rate(selected, threshold)


def build_report(
    rows: list[dict[str, Any]],
    *,
    registry_path: Path,
    thresholds: list[int],
    costs_usd: list[float],
    token_values_usd: list[float],
    attempts: list[int],
    worker_attempts: list[int],
    false_rejection_rates: list[float],
    burn_vrt: float,
    reward_vrt: float,
    daily_cap_vrt: float,
    per_wallet_cap_vrt: float,
) -> str:
    by_prompt = grouped_rows(rows)
    non_fallback_rows = [row for row in rows if prompt_id(row) not in FALLBACK_PROMPTS]
    fallback_rows = [row for row in rows if prompt_id(row) in FALLBACK_PROMPTS]
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    breakeven_pass_rate = burn_vrt / reward_vrt

    lines = [
        "# Phase 3A Economic Exposure",
        "",
        f"Generated: {generated}",
        "",
        f"Registry: `{relative(registry_path)}`",
        "",
        "Scope: registry-only economic sensitivity model. It uses saved `real_001` scores and explicit inference-cost assumptions; it does not run Ollama, providers, embeddings, scorer code, or network calls.",
        "",
        "Related local timing artifact: `docs/eval/PHASE3A_LOCAL_TIMING_LOG.md`.",
        "",
        "## Assumptions",
        "",
        markdown_table(
            ["Variable", "Value", "Note"],
            [
                ["Burn per attempt", f"{burn_vrt:g} VRT", "Current modeled burn."],
                ["Reward per success", f"{reward_vrt:g} VRT", "Current modeled mint/reward."],
                ["Token-only breakeven pass rate", pct(breakeven_pass_rate), "Ignoring inference/orchestration cost."],
                ["Fallback prompt handling", ", ".join(sorted(FALLBACK_PROMPTS)), "Excluded from main rates because saved rows used fallback semantics."],
                ["Inference costs", ", ".join(money(value) for value in costs_usd), "Scenario inputs, not externally verified market prices."],
                ["Token values", ", ".join(money(value) for value in token_values_usd), "Scenario inputs for fiat sensitivity."],
                ["Hybrid subsidy cap", f"{daily_cap_vrt:g} VRT/day", "Scenario input for capped-subsidy mode."],
                ["Per-wallet subsidy cap", f"{per_wallet_cap_vrt:g} VRT/wallet/day", "Scenario input for rate-limited minted or hybrid rewards."],
                ["False-rejection rates", ", ".join(pct(value) for value in false_rejection_rates), "Scenario inputs for honest-worker capital risk."],
            ],
        ),
        "",
        "## Observed Attacker Pass Rate By Threshold",
        "",
    ]

    pass_rows = []
    all_rates = []
    for threshold in thresholds:
        aggregate_rate = pass_rate(non_fallback_rows, threshold)
        all_rate = pass_rate(rows, threshold)
        all_rates.append((threshold, aggregate_rate))
        pass_rows.append(
            [
                str(threshold),
                f"{sum(score(row) >= threshold for row in non_fallback_rows)}/{len(non_fallback_rows)}",
                pct(aggregate_rate),
                prompt_range_for_threshold(by_prompt, threshold),
                f"{sum(score(row) >= threshold for row in rows)}/{len(rows)} ({pct(all_rate)})",
            ]
        )
    lines.append(
        markdown_table(
            [
                "Threshold",
                "Non-fallback passes",
                "Aggregate pass rate",
                "Per-prompt pass-rate range",
                "All rows incl. fallback",
            ],
            pass_rows,
        )
    )

    lines.extend(["", "## Weakest-Link Prompt Risk", ""])
    weakest_rows = []
    for threshold, aggregate_rate in all_rates:
        aggregate_net = net_vrt_per_attempt(aggregate_rate, burn_vrt=burn_vrt, reward_vrt=reward_vrt)
        prompt_name, prompt_rate, prompt_net = weakest_link_for_threshold(
            by_prompt,
            threshold,
            burn_vrt=burn_vrt,
            reward_vrt=reward_vrt,
        )
        weakest_rows.append(
            [
                str(threshold),
                pct(aggregate_rate),
                vrt(aggregate_net),
                prompt_name,
                prompt_rate,
                prompt_net,
            ]
        )
    lines.append(
        markdown_table(
            [
                "Threshold",
                "Aggregate pass rate",
                "Aggregate net VRT/attempt",
                "Highest-passing prompt(s)",
                "Prompt pass rate",
                "Prompt net VRT/attempt",
            ],
            weakest_rows,
        )
    )

    lines.extend(["", "## Review-Class Quality Risk", ""])
    class_rows = []
    for threshold in thresholds:
        plausible = review_class_rate(non_fallback_rows, threshold, "topical and plausible")
        shallow = review_class_rate(non_fallback_rows, threshold, "topical but shallow")
        class_rows.append(
            [
                str(threshold),
                pct(plausible),
                pct(shallow),
                f"{(shallow - plausible) * 100:+.1f} pp",
            ]
        )
    lines.append(
        markdown_table(
            ["Threshold", "Topical/plausible pass rate", "Topical/shallow pass rate", "Shallow minus plausible"],
            class_rows,
        )
    )

    lines.extend(["", "## Funding Modes And Rate-Limit Overlay", ""])
    gross_reward_55 = pass_rate(non_fallback_rows, 55) * reward_vrt * 1000
    net_supply_55 = net_vrt_per_attempt(pass_rate(non_fallback_rows, 55), burn_vrt=burn_vrt, reward_vrt=reward_vrt) * 1000
    cap_covered_attempts = daily_cap_vrt / reward_vrt if reward_vrt else 0.0
    per_wallet_successes = per_wallet_cap_vrt / reward_vrt if reward_vrt else 0.0
    per_wallet_attempts_at_55 = per_wallet_successes / pass_rate(non_fallback_rows, 55) if pass_rate(non_fallback_rows, 55) else 0.0
    mode_rows = [
        [
            "Protocol-minted reward",
            "Protocol mints rewards and burns attempts.",
            f"At T=55, 1000 automated attempts imply about {vrt(gross_reward_55)} VRT minted rewards and {vrt(net_supply_55)} net VRT after burns.",
            "Dangerous at T=55-65; at T=70 aggregate EV is negative, but weakest-link prompt routing is still positive in saved rows.",
            "Compact-model success is an exploit unless reward supply is externally constrained or capped.",
        ],
        [
            "Stakeholder-funded bounty / escrow",
            "External stakeholder funds accepted-output rewards.",
            "No open-ended protocol mint is required; stakeholder pays for successful outputs.",
            "Conditionally workable only if stakeholders genuinely value topical/compliant outputs. Cross-tab anti-alignment means shallow outputs survive tightening better than plausible ones.",
            "Compact-model success can be desirable supplier efficiency, but only if the buyer's value definition matches what V5.1 actually selects.",
        ],
        [
            "Hybrid capped-subsidy",
            "Protocol subsidizes rewards up to a finite cap, then stops or reverts to stakeholder funding.",
            f"With a {vrt(daily_cap_vrt)} VRT/day cap, only about {cap_covered_attempts:.1f} full {reward_vrt:g} VRT rewards fit before the subsidy is exhausted.",
            "Contains treasury exposure but does not fix scorer quality or weak-prompt routing. Automation can simply consume the cap.",
            "Compact-model success is acceptable only inside explicit budget, rate, and quality-review constraints.",
        ],
        [
            "Per-wallet cap overlay",
            "Same funding source as protocol-minted or hybrid mode, but each wallet can claim only a bounded subsidy per epoch.",
            f"With a {vrt(per_wallet_cap_vrt)} VRT/wallet/day cap, one wallet receives at most about {per_wallet_successes:.1f} full rewards; at T=55 that is roughly {per_wallet_attempts_at_55:.1f} observed attempts before the cap binds.",
            "Limits single-wallet drain, but does not stop Sybil routing without stake, identity, reputation, allowlists, or external risk controls.",
            "Turns compact-model automation from unlimited volume into a Sybil and allocation problem; it is cheaper and less gameable than automatic threshold changes, but not sufficient alone.",
        ],
    ]
    lines.append(
        markdown_table(
            [
                "Funding mode",
                "Who pays",
                "Economic exposure",
                "Prompt/selective risk",
                "Small-model automation read",
            ],
            mode_rows,
        )
    )

    lines.extend(["", "## Honest Worker Upfront Capital Risk", ""])
    lines.extend(
        [
            "This table models valid human work that should pass, but is falsely rejected by the evaluator.",
            "The worker still pays the burn on every attempt; a false rejection means losing the burn without receiving the reward.",
            "",
        ]
    )
    worker_headers = [
        "False rejection rate",
        "Net VRT/valid attempt",
        "Expected false-rejection burn per attempt",
        *[f"expected burn loss / {count} attempts" for count in worker_attempts],
        *[f"P(any false reject in {count})" for count in worker_attempts],
    ]
    worker_rows = []
    for false_rejection_rate in false_rejection_rates:
        net_valid = honest_worker_net_vrt(
            false_rejection_rate,
            burn_vrt=burn_vrt,
            reward_vrt=reward_vrt,
        )
        expected_burn_per_attempt = false_rejection_rate * burn_vrt
        worker_rows.append(
            [
                pct(false_rejection_rate),
                vrt(net_valid),
                vrt(expected_burn_per_attempt),
                *[vrt(expected_burn_per_attempt * count) for count in worker_attempts],
                *[pct(chance_at_least_one_false_rejection(false_rejection_rate, count)) for count in worker_attempts],
            ]
        )
    lines.append(markdown_table(worker_headers, worker_rows))

    lines.extend(["", "## Token EV Per Attempt", ""])
    token_rows = []
    for threshold, aggregate_rate in all_rates:
        net_vrt = net_vrt_per_attempt(aggregate_rate, burn_vrt=burn_vrt, reward_vrt=reward_vrt)
        token_rows.append(
            [
                str(threshold),
                pct(aggregate_rate),
                vrt(net_vrt),
                "positive before inference" if net_vrt > 0 else "negative before inference",
            ]
        )
    lines.append(markdown_table(["Threshold", "Pass rate", "Net VRT/attempt", "Token-only status"], token_rows))

    lines.extend(["", "## Breakeven VRT Fiat Value", ""])
    breakeven_headers = ["Threshold", "Pass rate"] + [f"cost {money(cost)}" for cost in costs_usd]
    breakeven_rows = []
    for threshold, aggregate_rate in all_rates:
        breakeven_rows.append(
            [
                str(threshold),
                pct(aggregate_rate),
                *[
                    breakeven_token_value(
                        aggregate_rate,
                        burn_vrt=burn_vrt,
                        reward_vrt=reward_vrt,
                        inference_cost_usd=cost,
                    )
                    for cost in costs_usd
                ],
            ]
        )
    lines.append(markdown_table(breakeven_headers, breakeven_rows))

    lines.extend(["", "## Fiat EV Examples", ""])
    example_headers = ["Threshold", "Pass rate", "VRT value", "Inference cost", "EV/attempt"] + [
        f"{count} attempts" for count in attempts
    ]
    example_rows = []
    selected_thresholds = [threshold for threshold in thresholds if threshold in {55, 65, 70, 75}]
    if not selected_thresholds:
        selected_thresholds = thresholds
    for threshold, aggregate_rate in all_rates:
        if threshold not in selected_thresholds:
            continue
        for token_value in token_values_usd:
            for cost in costs_usd:
                ev_attempt = fiat_ev_per_attempt(
                    aggregate_rate,
                    burn_vrt=burn_vrt,
                    reward_vrt=reward_vrt,
                    token_value_usd=token_value,
                    inference_cost_usd=cost,
                )
                example_rows.append(
                    [
                        str(threshold),
                        pct(aggregate_rate),
                        money(token_value),
                        money(cost),
                        money(ev_attempt),
                        *[money(ev_attempt * count) for count in attempts],
                    ]
                )
    lines.append(markdown_table(example_headers, example_rows))

    lines.extend(["", "## Per-Prompt Economic Inputs", ""])
    prompt_headers = ["Prompt", "Rows", "Score range", "Mean score"] + [f">={threshold}" for threshold in thresholds]
    prompt_rows = []
    for pid in sorted(by_prompt):
        prompt_scores = [score(row) for row in by_prompt[pid]]
        score_range = f"{min(prompt_scores)}-{max(prompt_scores)}"
        mean_score = f"{statistics.fmean(prompt_scores):.1f}"
        prompt_rows.append(
            [
                pid,
                str(len(prompt_scores)),
                score_range,
                mean_score,
                *[pct(pass_rate(by_prompt[pid], threshold)) for threshold in thresholds],
            ]
        )
    lines.append(markdown_table(prompt_headers, prompt_rows))

    lines.extend(
        [
            "",
            "## Interpretation",
            "",
            "- At thresholds 55, 60, and 65, the non-fallback observed pass rate is above the token-only breakeven pass rate of "
            f"{pct(breakeven_pass_rate)}, so any positive VRT value above the tiny breakeven fiat value can make automated attempts profitable under these assumptions.",
            "- At threshold 70 and above, the aggregate non-fallback pass rate falls below token-only breakeven, but weakest-link prompts remain above breakeven at threshold 70 in the saved rows.",
            "- The observed rates for thresholds above 55 are projections from a generator run against threshold 55. They should be treated as lower-bound risk indicators, not as optimized attacker ceilings.",
            "- This table does not say the protocol should raise threshold. The threshold x review-class artifact shows that threshold-only tuning does not cleanly separate plausible from shallow outputs on this visible slice.",
            "- Funding mode changes who bears the loss; it does not automatically make compact-model automation good or bad. The stakeholder-funded case is viable only if the stakeholder values what the scorer actually selects.",
            "- Per-wallet caps can bound single-address extraction, but they should be treated as exposure controls rather than quality controls. Without a Sybil-resistance layer, a farm can distribute attempts across many wallets.",
            "- False rejections create a protocol-specific worker UX risk: centralized platforms often waste onboarding time, while PoPI can make honest workers lose burn capital on valid work.",
            "- The inference-cost rows are sensitivity assumptions. Current cloud/API pricing was not fetched or verified in this artifact.",
        ]
    )
    if fallback_rows:
        lines.extend(
            [
                "",
                "## Fallback Caveat",
                "",
                f"`{', '.join(sorted(FALLBACK_PROMPTS))}` contributed {len(fallback_rows)} rows but is excluded from primary economic pass rates because the saved run used fallback semantic scoring. Including it makes threshold 55 look like `{pct(pass_rate(rows, 55))}` overall, but that is not a clean quality/economic input.",
            ]
        )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Phase 3A economic exposure table from saved registry rows.")
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--threshold", action="append", default=None)
    parser.add_argument("--cost-usd", action="append", default=None)
    parser.add_argument("--token-value-usd", action="append", default=None)
    parser.add_argument("--attempts", action="append", default=None)
    parser.add_argument("--worker-attempts", action="append", default=None)
    parser.add_argument("--false-rejection-rate", action="append", default=None)
    parser.add_argument("--burn-vrt", type=float, default=DEFAULT_BURN_VRT)
    parser.add_argument("--reward-vrt", type=float, default=DEFAULT_REWARD_VRT)
    parser.add_argument("--daily-cap-vrt", type=float, default=DEFAULT_DAILY_CAP_VRT)
    parser.add_argument("--per-wallet-cap-vrt", type=float, default=DEFAULT_PER_WALLET_CAP_VRT)
    parser.add_argument("--print", action="store_true", help="Print markdown to stdout instead of writing --out.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    registry_path = resolve_path(args.registry)
    rows = load_jsonl(registry_path)
    report = build_report(
        rows,
        registry_path=registry_path,
        thresholds=[int(value) for value in parse_numbers(args.threshold, tuple(float(v) for v in DEFAULT_THRESHOLDS))],
        costs_usd=parse_numbers(args.cost_usd, DEFAULT_COSTS_USD),
        token_values_usd=parse_numbers(args.token_value_usd, DEFAULT_TOKEN_VALUES_USD),
        attempts=parse_ints(args.attempts, DEFAULT_ATTEMPTS),
        worker_attempts=parse_ints(args.worker_attempts, DEFAULT_WORKER_ATTEMPTS),
        false_rejection_rates=parse_numbers(args.false_rejection_rate, DEFAULT_FALSE_REJECTION_RATES),
        burn_vrt=args.burn_vrt,
        reward_vrt=args.reward_vrt,
        daily_cap_vrt=args.daily_cap_vrt,
        per_wallet_cap_vrt=args.per_wallet_cap_vrt,
    )
    if args.print:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        print(report)
    else:
        out_path = resolve_path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(report + "\n", encoding="utf-8")
        print(f"Wrote {relative(out_path)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
