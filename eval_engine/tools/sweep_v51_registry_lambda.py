"""Registry-only lambda sweep for V5.1 Attack B rows.

This does not load the embedding model. It infers the original reference
similarity from rows that already contain contrastive semantic_coherence and
max_filler_sim:

    semantic = rescale * max(0, sim_ref - lambda * sim_filler)

Rows that used semantic fallback should be excluded, because sim_ref cannot be
recovered from fallback values.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SEMANTIC_WEIGHT = 0.60
DEFAULT_THRESHOLD = 55
DEFAULT_BASE_LAMBDA = 1.0
DEFAULT_RESCALE = 2.0
DEFAULT_LAMBDAS = (0.0, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.25, 1.5)


def resolve_path(path: Path) -> Path:
    if path.is_absolute():
        return path
    return (REPO_ROOT / path).resolve()


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


def parse_lambdas(values: list[str] | None) -> list[float]:
    if not values:
        return list(DEFAULT_LAMBDAS)
    parsed: list[float] = []
    for value in values:
        parsed.extend(float(part) for part in value.split(",") if part.strip())
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run an offline V5.1 lambda sweep from a registry JSONL.")
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--exclude-prompt", action="append", default=[])
    parser.add_argument("--lambda", dest="lambdas", action="append", default=None)
    parser.add_argument("--base-lambda", type=float, default=DEFAULT_BASE_LAMBDA)
    parser.add_argument("--rescale", type=float, default=DEFAULT_RESCALE)
    parser.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    registry_path = resolve_path(args.registry)
    rows = load_jsonl(registry_path)
    excluded_prompts = set(args.exclude_prompt)
    usable: list[tuple[str, float, float, float]] = []
    skipped = 0

    for row in rows:
        prompt_id = str(row.get("prompt_id", ""))
        diagnostics = row.get("private_evaluation_not_returned_to_attacker", {})
        components = diagnostics.get("components", {})
        semantic = components.get("semantic_coherence")
        filler = diagnostics.get("max_filler_sim")
        raw_score = diagnostics.get("raw_score")
        if prompt_id in excluded_prompts or semantic is None or filler is None or raw_score is None:
            skipped += 1
            continue

        semantic = float(semantic)
        filler = float(filler)
        raw_score = float(raw_score)
        raw_without_semantic = raw_score - (SEMANTIC_WEIGHT * semantic)
        inferred_sim_ref = (semantic / args.rescale) + (args.base_lambda * filler)
        usable.append((prompt_id, raw_without_semantic, inferred_sim_ref, filler))

    print(
        "mode=inferred_contrastive "
        f"registry={registry_path.relative_to(REPO_ROOT) if registry_path.is_relative_to(REPO_ROOT) else registry_path} "
        f"usable_rows={len(usable)} skipped_rows={skipped} "
        f"base_lambda={args.base_lambda} rescale={args.rescale}"
    )
    if excluded_prompts:
        print(f"excluded_prompts={sorted(excluded_prompts)}")
    if not usable:
        print("No usable rows for lambda sweep.", file=sys.stderr)
        return 1

    for lambda_value in parse_lambdas(args.lambdas):
        scores: list[int] = []
        by_prompt: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        for prompt_id, raw_without_semantic, sim_ref, filler in usable:
            semantic = min(1.0, max(0.0, sim_ref - (lambda_value * filler)) * args.rescale)
            score = round((raw_without_semantic + (SEMANTIC_WEIGHT * semantic)) * 100)
            scores.append(score)
            by_prompt[prompt_id][0] += int(score >= args.threshold)
            by_prompt[prompt_id][1] += 1

        prompt_summary = ", ".join(
            f"{prompt_id}:{passed}/{total}"
            for prompt_id, (passed, total) in sorted(by_prompt.items())
        )
        print(
            f"lambda={lambda_value:.2f} "
            f"pass={sum(score >= args.threshold for score in scores)}/{len(scores)} "
            f"min={min(scores)} max={max(scores)} mean={sum(scores) / len(scores):.1f} "
            f"| {prompt_summary}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
