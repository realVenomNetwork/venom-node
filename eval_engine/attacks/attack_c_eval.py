"""Attack C: casual honest corpus ingestion/evaluation scaffold.

This utility evaluates supplied human/corpus answers with the hybrid V5.3.1
scorer (Deterministic + Semantic).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / 'eval_engine'))

from attacks.v51_scoring import (
    load_prompt_records,
    prompt_spec_from_record,
    records_to_jsonl,
    resolve_repo_path,
    build_semantic_scorer,
    score_for_attack_c,
)


DEFAULT_MANIFEST = REPO_ROOT / "docs" / "eval" / "V5_1_ARTIFACT_MANIFEST.json"
DEFAULT_OUT = REPO_ROOT / "attack_runs" / "attack_c" / "results.jsonl"
DEFAULT_SUMMARY = REPO_ROOT / "attack_runs" / "attack_c" / "summary.json"
DEFAULT_CATALOGS = [
    REPO_ROOT / "data" / "prompts" / "public.json",
    REPO_ROOT / "data" / "prompts" / "rotating.json",
]
BUCKET_FIELDS = ("length_bucket", "register", "proficiency", "domain", "source")
RATING_FIELDS = ("human_quality_rating", "quality_rating", "rating")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def relative(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path.resolve())


def load_corpus(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".jsonl":
        return load_prompt_records(path)
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        raw = payload.get("items", payload.get("corpus", payload.get("honest_outputs", payload.get("prompts", []))))
    else:
        raw = payload
    return [dict(item) for item in raw]


def load_catalog(paths: list[Path]) -> dict[str, dict[str, Any]]:
    catalog: dict[str, dict[str, Any]] = {}
    for path in paths:
        if not path.exists():
            continue
        for record in load_prompt_records(path):
            if "id" in record:
                catalog[str(record["id"])] = dict(record)
    return catalog


def normalize_corpus_item(
    item: dict[str, Any],
    catalog: dict[str, dict[str, Any]],
) -> tuple[dict[str, Any], str, list[str]]:
    item_id = str(item.get("id", item.get("prompt_id", ""))).strip()
    warnings: list[str] = []
    if not item_id:
        raise ValueError("Corpus item is missing id/prompt_id.")

    answer = str(
        item.get(
            "human_answer",
            item.get("honest_answer", item.get("output", item.get("output_text", item.get("payload", "")))),
        )
    )
    if not answer.strip():
        raise ValueError(f"Corpus item {item_id} is missing human_answer/honest_answer/output.")

    catalog_record = catalog.get(item_id)
    if catalog_record is not None:
        spec_record = dict(catalog_record)
        prompt_from_item = item.get("prompt", item.get("prompt_text"))
        if prompt_from_item and spec_record.get("prompt") != prompt_from_item:
            warnings.append("item_prompt_differs_from_catalog_prompt; catalog prompt/reference used for scoring")
    else:
        spec_record = {
            "id": item_id,
            "tier": item.get("tier", "attack_corpus"),
            "prompt": item.get("prompt", item.get("prompt_text", "")),
            "reference_answer": item.get("reference_answer", ""),
            "min_length": item.get("min_length", max(1, len(answer.split()) - 20)),
            "max_length": item.get("max_length", len(answer.split()) + 40),
            "must_contain_any": item.get("must_contain_any", []),
        }
        if not spec_record["reference_answer"]:
            warnings.append("missing_reference_answer; semantic scoring will be zero")

    return spec_record, answer, warnings


def mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def pass_rate(records: list[dict[str, Any]]) -> float | None:
    if not records:
        return None
    return sum(1 for record in records if record["passes_threshold"]) / len(records)


def summarize_group(records: list[dict[str, Any]]) -> dict[str, Any]:
    scores = [float(record["v5_3_1_score"]) for record in records]
    semantics = [float(record["semantic_score"]) for record in records]
    deterministic = [float(record["deterministic_score"]) for record in records]
    return {
        "count": len(records),
        "mean_v5_3_1_score": mean(scores),
        "pass_rate": pass_rate(records),
        "mean_semantic_score": mean(semantics),
        "mean_deterministic_score": mean(deterministic),
    }


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    summary: dict[str, Any] = {"overall": summarize_group(records), "by_bucket": {}}
    for field in BUCKET_FIELDS:
        groups: dict[str, list[dict[str, Any]]] = {}
        for record in records:
            value = record.get(field)
            if value is None:
                continue
            groups.setdefault(str(value), []).append(record)
        summary["by_bucket"][field] = {
            value: summarize_group(group_records)
            for value, group_records in sorted(groups.items())
        }

    rating_values: list[float] = []
    for record in records:
        for field in RATING_FIELDS:
            if record.get(field) is None:
                continue
            try:
                rating_values.append(float(record[field]))
            except (TypeError, ValueError):
                continue
            break
    summary["label_summary"] = {
        "rating_fields_checked": list(RATING_FIELDS),
        "rated_item_count": len(rating_values),
        "mean_human_quality_rating": mean(rating_values),
    }
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate an Attack C corpus with V5.3.1.")
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--prompt-catalog", type=Path, action="append", default=None)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--summary-out", type=Path, default=DEFAULT_SUMMARY)
    parser.add_argument("--limit", type=int, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest_path = resolve_repo_path(args.manifest)
    corpus_path = resolve_repo_path(args.corpus)
    catalog_paths = [resolve_repo_path(path) for path in (args.prompt_catalog or DEFAULT_CATALOGS)]
    out_path = resolve_repo_path(args.out)
    summary_path = resolve_repo_path(args.summary_out)

    corpus = load_corpus(corpus_path)
    if args.limit is not None:
        corpus = corpus[: args.limit]
    catalog = load_catalog(catalog_paths)
    
    # Initialize v5.3.1 Semantic Scorer
    model = build_semantic_scorer()
    manifest_hash = sha256_file(manifest_path) if manifest_path.exists() else "unknown"

    results: list[dict[str, Any]] = []
    for item in corpus:
        spec_record, answer, warnings = normalize_corpus_item(item, catalog)
        # Using the new score_for_attack_c function
        diagnostics = score_for_attack_c(answer, spec_record.get("reference_answer"), model=model)
        
        result = {
            "id": str(item.get("id", item.get("prompt_id"))),
            "evaluated_at": utc_now(),
            "artifact_manifest": relative(manifest_path),
            "artifact_manifest_sha256": manifest_hash,
            "reference_source": "prompt_catalog" if str(item.get("id", item.get("prompt_id"))) in catalog else "corpus_item",
            "warnings": warnings,
            "v5_3_1_score": diagnostics["score"],
            "semantic_score": diagnostics["semantic_score"],
            "deterministic_score": diagnostics["deterministic_score"],
            "passes_threshold": diagnostics["passes_threshold"],
            "reasons": diagnostics["reasons"],
            "length_bucket": item.get("length_bucket"),
            "register": item.get("register"),
            "proficiency": item.get("proficiency"),
            "domain": item.get("domain"),
            "source": item.get("source"),
        }
        for field in RATING_FIELDS:
            if field in item:
                result[field] = item[field]
        results.append(result)

    summary = summarize(results)
    summary.update(
        {
            "generated_at": utc_now(),
            "corpus": relative(corpus_path),
            "artifact_manifest": relative(manifest_path),
            "artifact_manifest_sha256": manifest_hash,
            "catalogs": [relative(path) for path in catalog_paths if path.exists()],
        }
    )

    records_to_jsonl(results, out_path)
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(f"Attack C evaluated items: {len(results)}")
    print(f"Per-item results: {out_path}")
    print(f"Summary: {summary_path}")
    if "overall" in summary:
        print(json.dumps(summary["overall"], indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
