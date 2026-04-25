"""Threshold by review-class cross-tab for Phase 3A visible Attack B rows.

This is registry-only and does not import evaluator or embedding code. Review
classes are prompt-level labels from manual inspection of the highest-scoring
real_001 candidate; counts are computed across every saved real_001 row for
that prompt.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REGISTRY = REPO_ROOT / "attack_runs" / "attack_b_passfail_v51_real_001_registry.jsonl"
DEFAULT_OUT = REPO_ROOT / "docs" / "eval" / "PHASE3A_THRESHOLD_REVIEW_CROSSTAB.md"
DEFAULT_THRESHOLDS = (55, 60, 65, 70, 75)


@dataclass(frozen=True)
class ReviewClass:
    label: str
    basis: str


REVIEW_CLASSES = {
    "pub_001": ReviewClass(
        "topical and plausible",
        "Winner is a usable but generic staff memo; one encoding artifact.",
    ),
    "pub_002": ReviewClass(
        "topical and plausible",
        "Winner is a legitimate alternate analogy and answer.",
    ),
    "pub_003": ReviewClass(
        "topical but shallow",
        "Winner is on topic but does not cleanly separate emotional motivations.",
    ),
    "pub_004": ReviewClass(
        "topical but shallow",
        "Winner is topical but diagnostically muddled and partially wrong.",
    ),
    "pub_005": ReviewClass(
        "fallback-confounded",
        "All saved real_001 rows use semantic_coherence=0.5 fallback; analyze separately.",
    ),
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


def parse_thresholds(values: list[str] | None) -> list[int]:
    if not values:
        return list(DEFAULT_THRESHOLDS)
    thresholds: list[int] = []
    for value in values:
        thresholds.extend(int(part) for part in value.split(",") if part.strip())
    return sorted(set(thresholds))


def markdown_table(headers: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |"]
    out.append("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        clean = [cell.replace("\n", "<br>").replace("|", "\\|") for cell in row]
        out.append("| " + " | ".join(clean) + " |")
    return "\n".join(out)


def count_at_threshold(scores: list[int], threshold: int) -> str:
    passed = sum(value >= threshold for value in scores)
    pct = (passed / len(scores)) * 100 if scores else 0.0
    return f"{passed}/{len(scores)} ({pct:.0f}%)"


def summarize_scores(scores: list[int]) -> tuple[str, str]:
    if not scores:
        return "n/a", "n/a"
    return f"{min(scores)}-{max(scores)}", f"{statistics.fmean(scores):.1f}"


def build_report(rows: list[dict[str, Any]], *, thresholds: list[int], registry_path: Path) -> str:
    by_class: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_prompt: dict[str, list[dict[str, Any]]] = defaultdict(list)
    skipped: list[str] = []

    for row in rows:
        pid = prompt_id(row)
        if pid not in REVIEW_CLASSES:
            skipped.append(pid)
            continue
        by_class[REVIEW_CLASSES[pid].label].append(row)
        by_prompt[pid].append(row)

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [
        "# Phase 3A Threshold x Review-Class Cross-Tab",
        "",
        f"Generated: {generated}",
        "",
        f"Registry: `{relative(registry_path)}`",
        "",
        "Scope: registry-only cross-tab over saved `real_001` Attack B rows. No model or provider code is run.",
        "",
        "Review class is assigned per prompt from manual inspection of the highest-scoring candidate in `PHASE3A_VISIBLE_BREACH_AUDIT.md`. Counts below use all saved rows for that prompt.",
        "",
        "## Classification Basis",
        "",
    ]

    basis_rows = []
    for pid in sorted(REVIEW_CLASSES):
        review = REVIEW_CLASSES[pid]
        basis_rows.append([pid, review.label, review.basis])
    lines.append(markdown_table(["Prompt", "Review class", "Basis"], basis_rows))

    lines.extend(["", "## Class-Level Cross-Tab", ""])
    class_headers = ["Review class", "Prompts", "Rows", "Score range", "Mean score"] + [
        f">={threshold}" for threshold in thresholds
    ]
    class_rows = []
    for label in sorted(by_class):
        class_rows_for_label = by_class[label]
        scores = [score(row) for row in class_rows_for_label]
        prompt_ids = sorted({prompt_id(row) for row in class_rows_for_label})
        score_range, mean_score = summarize_scores(scores)
        class_rows.append(
            [
                label,
                ", ".join(prompt_ids),
                str(len(scores)),
                score_range,
                mean_score,
                *[count_at_threshold(scores, threshold) for threshold in thresholds],
            ]
        )
    lines.append(markdown_table(class_headers, class_rows))

    lines.extend(["", "## Prompt-Level Cross-Tab", ""])
    prompt_headers = ["Prompt", "Review class", "Rows", "Score range", "Mean score"] + [
        f">={threshold}" for threshold in thresholds
    ]
    prompt_rows = []
    for pid in sorted(by_prompt):
        scores = [score(row) for row in by_prompt[pid]]
        score_range, mean_score = summarize_scores(scores)
        prompt_rows.append(
            [
                pid,
                REVIEW_CLASSES[pid].label,
                str(len(scores)),
                score_range,
                mean_score,
                *[count_at_threshold(scores, threshold) for threshold in thresholds],
            ]
        )
    lines.append(markdown_table(prompt_headers, prompt_rows))

    lines.extend(
        [
            "",
            "## Reading Notes",
            "",
            "- `pub_005` is intentionally separated as `fallback-confounded`; its `real_001` scores should not be used to tune semantic quality because every saved row used fallback `semantic_coherence=0.5`.",
            "- Raising a threshold high enough to suppress most `topical but shallow` rows also removes many `topical and plausible` rows in this small visible slice.",
            "- This table is scope-neutral. It informs Scope A/C calibration, but it does not decide the product scope or resolve economic exposure.",
        ]
    )
    if skipped:
        lines.extend(["", f"Skipped rows with unmapped prompt ids: `{sorted(set(skipped))}`"])
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Threshold x Review-Class cross-tab from real_001 registry rows.")
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--threshold", action="append", default=None)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--print", action="store_true", help="Print markdown to stdout instead of writing --out.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    registry_path = resolve_path(args.registry)
    thresholds = parse_thresholds(args.threshold)
    rows = load_jsonl(registry_path)
    report = build_report(rows, thresholds=thresholds, registry_path=registry_path)

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
