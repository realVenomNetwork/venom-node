"""Tabulate supplied Grok corpus artifacts into an Attack C JSONL fixture.

This is intentionally a no-model utility. It validates shape, provenance, and
coverage before any V5.1 scoring run. Synthetic or unverified rows are preserved
as fixtures, but the generated report blocks them from being interpreted as
human false-rejection-rate evidence.
"""

from __future__ import annotations

import argparse
import collections
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "attack_runs" / "attack_c" / "grok_synthetic_fixture_20260422.jsonl"
DEFAULT_SUMMARY = REPO_ROOT / "attack_runs" / "attack_c" / "grok_synthetic_fixture_20260422_summary.json"
DEFAULT_REPORT = REPO_ROOT / "docs" / "strategy" / "GROK_ATTACK_C_CORPUS_SMOKE.md"

REQUIRED_FIELDS = ("id", "prompt", "human_answer")
CORE_ATTACK_C_FIELDS = (
    "id",
    "prompt",
    "human_answer",
    "length_bucket",
    "register",
    "proficiency",
    "domain",
    "source",
    "human_quality_rating",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def repo_relative(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path.resolve())


def load_jsonish(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8-sig")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"(\[\s*\{.*\}\s*\])", text, flags=re.DOTALL)
        if not match:
            raise
        payload = json.loads(match.group(1))

    if isinstance(payload, dict):
        raw = payload.get("items", payload.get("corpus", payload.get("records", [])))
    else:
        raw = payload
    if not isinstance(raw, list):
        raise ValueError(f"{path} must contain a JSON array or object with items/corpus/records.")
    return [dict(item) for item in raw]


def classify_item(item: dict[str, Any]) -> dict[str, Any]:
    tier = str(item.get("provenance_tier") or "").strip() or "missing"
    synthetic = bool(item.get("synthetic"))
    missing = [field for field in REQUIRED_FIELDS if not str(item.get(field, "")).strip()]
    has_reference = bool(str(item.get("reference_answer", "")).strip())

    if missing:
        review_status = "disapproved"
        reason = f"missing required fields: {', '.join(missing)}"
    elif tier == "verified_url" and has_reference:
        review_status = "approved"
        reason = "verified source and scorer reference are present"
    elif tier == "verified_url":
        review_status = "suggestion_for_new_entry"
        reason = "verified source present, but scorer reference_answer is missing"
    elif tier == "synthetic" or synthetic:
        review_status = "approved_for_synthetic_fixture_only"
        reason = "synthetic fixture; not valid human FPR evidence"
    elif tier == "historical_unverified":
        review_status = "disapproved_for_human_fpr"
        reason = "historical/unverified source without live URL or source hash"
    elif tier == "claimed_url_unverified":
        review_status = "disapproved_for_human_fpr"
        reason = "claimed URL must resolve and match before human-FPR use"
    else:
        review_status = "disapproved"
        reason = "missing or unsupported provenance_tier"

    suggested_fix = None
    if review_status in {"disapproved", "disapproved_for_human_fpr"}:
        suggested_fix = (
            "verify source_url and source text, or relabel as synthetic; add reference_answer "
            "before V5.1 semantic scoring"
        )
    elif review_status == "suggestion_for_new_entry":
        suggested_fix = "add reviewed reference_answer and prompt bounds"

    return {
        "review_status": review_status,
        "reason": reason,
        "suggested_fix": suggested_fix,
        "missing_required_fields": missing,
        "has_reference_answer": has_reference,
    }


def normalize_item(item: dict[str, Any], source_file: Path, source_index: int) -> dict[str, Any]:
    normalized = dict(item)
    review = classify_item(normalized)
    normalized.setdefault("human_quality_rating", None)
    normalized["_source_artifact"] = str(source_file)
    normalized["_source_artifact_index"] = source_index
    normalized["attack_c_fixture_review"] = review
    normalized["attack_c_use"] = (
        "synthetic_fixture_only"
        if review["review_status"] == "approved_for_synthetic_fixture_only"
        else "blocked_until_provenance_or_reference_upgrade"
    )
    return normalized


def counter_dict(items: list[dict[str, Any]], field: str) -> dict[str, int]:
    return dict(sorted(collections.Counter(str(item.get(field)) for item in items).items()))


def build_summary(items: list[dict[str, Any]], artifact_paths: list[Path], out_jsonl: Path) -> dict[str, Any]:
    ids = [str(item.get("id", "")) for item in items]
    duplicate_ids = sorted([item_id for item_id, count in collections.Counter(ids).items() if count > 1])
    missing_required = {
        str(item.get("id", f"row_{idx}")): item["attack_c_fixture_review"]["missing_required_fields"]
        for idx, item in enumerate(items, start=1)
        if item["attack_c_fixture_review"]["missing_required_fields"]
    }
    review_counts = collections.Counter(item["attack_c_fixture_review"]["review_status"] for item in items)
    reference_missing = sum(1 for item in items if not item["attack_c_fixture_review"]["has_reference_answer"])
    verified_count = sum(1 for item in items if item.get("provenance_tier") == "verified_url")

    return {
        "generated_at": utc_now(),
        "source_artifacts": [str(path) for path in artifact_paths],
        "output_jsonl": repo_relative(out_jsonl),
        "total_items": len(items),
        "unique_ids": len(set(ids)),
        "duplicate_ids": duplicate_ids,
        "missing_required": missing_required,
        "counts": {
            "review_status": dict(sorted(review_counts.items())),
            "provenance_tier": counter_dict(items, "provenance_tier"),
            "synthetic": counter_dict(items, "synthetic"),
            "length_bucket": counter_dict(items, "length_bucket"),
            "domain": counter_dict(items, "domain"),
            "register": counter_dict(items, "register"),
        },
        "reference_answer_missing_count": reference_missing,
        "verified_url_count": verified_count,
        "smoke_result": {
            "json_parse": "pass",
            "required_fields": "pass" if not missing_required else "fail",
            "unique_ids": "pass" if not duplicate_ids else "fail",
            "attack_c_jsonl_written": "pass",
            "human_fpr_ready": verified_count >= 10 and reference_missing == 0,
            "synthetic_fixture_ready": len(items) > 0 and not missing_required and not duplicate_ids,
            "meaningful_v51_scoring_ready": reference_missing == 0,
        },
        "blocking_notes": [
            "No row has reference_answer, so attack_c_eval.py would use semantic fallback unless references are added or IDs match prompt catalogs.",
            "Synthetic and historical_unverified rows must not be cited as human false rejection rate evidence.",
            "No long length_bucket rows are present.",
        ],
    }


def write_jsonl(items: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for item in items:
            handle.write(json.dumps(item, sort_keys=True) + "\n")


def write_summary(summary: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def format_count_table(counts: dict[str, int]) -> str:
    if not counts:
        return "| Value | Count |\n|---|---|\n"
    lines = ["| Value | Count |", "|---|---|"]
    for value, count in counts.items():
        lines.append(f"| `{value}` | {count} |")
    return "\n".join(lines) + "\n"


def sample_review(items: list[dict[str, Any]], status: str) -> dict[str, Any] | None:
    for item in items:
        if item["attack_c_fixture_review"]["review_status"] == status:
            return {
                "review_status": item["attack_c_fixture_review"]["review_status"],
                "id": item.get("id"),
                "reason": item["attack_c_fixture_review"]["reason"],
                "suggested_fix": item["attack_c_fixture_review"]["suggested_fix"],
            }
    return None


def write_report(items: list[dict[str, Any]], summary: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    approved_sample = sample_review(items, "approved_for_synthetic_fixture_only")
    disapproved_sample = sample_review(items, "disapproved_for_human_fpr")
    suggestion_sample = {
        "review_status": "suggestion_for_new_entry",
        "reason": "needed to make this corpus useful for provenance-valid DAO Attack C tests",
        "suggested_entry_shape": {
            "id": "dao_verified_001",
            "prompt": "Write a neutral 160-260 word briefing for the verified DAO proposal.",
            "human_answer": "Human-authored or reviewed briefing text.",
            "reference_answer": "Reviewed scorer reference for V5.1 semantic comparison.",
            "length_bucket": "long",
            "register": "delegate-note",
            "domain": "dao-governance",
            "source": "https://verified-proposal-url.example",
            "source_url": "https://verified-proposal-url.example",
            "provenance_tier": "verified_url",
            "verified_by": "manual checker",
            "verified_at": "YYYY-MM-DD",
            "human_quality_rating": None,
            "synthetic": False,
        },
    }

    lines = [
        "# Grok Attack C Corpus Smoke",
        "",
        "## Executive Summary",
        "",
        "Grok's supplied artifacts were converted into an Attack C-compatible JSONL fixture. This is a no-model ingestion smoke, not a V5.1 scoring run.",
        "",
        f"- Source artifacts: {', '.join(summary['source_artifacts'])}",
        f"- JSONL fixture: `{summary['output_jsonl']}`",
        f"- Total rows: {summary['total_items']}",
        f"- Unique IDs: {summary['unique_ids']}",
        f"- Human-FPR ready: `{summary['smoke_result']['human_fpr_ready']}`",
        f"- Synthetic-fixture ready: `{summary['smoke_result']['synthetic_fixture_ready']}`",
        f"- Meaningful V5.1 semantic scoring ready: `{summary['smoke_result']['meaningful_v51_scoring_ready']}`",
        "",
        "## Data Structure Reference",
        "",
        "The JSONL fixture keeps the fields accepted by `attacks/attack_c_eval.py` and preserves the stricter DAO provenance fields from `docs/strategy/DAO_BRIEFING_CORPUS_TEMPLATE.json`.",
        "",
        "Core Attack C fields:",
        "",
        "```json",
        json.dumps({field: f"<{field}>" for field in CORE_ATTACK_C_FIELDS}, indent=2),
        "```",
        "",
        "Additional gating fields added or preserved:",
        "",
        "```json",
        json.dumps(
            {
                "provenance_tier": "verified_url | claimed_url_unverified | synthetic | historical_unverified",
                "synthetic": "boolean",
                "source_url": "verified URL or null",
                "reference_answer": "required before meaningful V5.1 semantic scoring",
                "attack_c_fixture_review": {
                    "review_status": "approved_for_synthetic_fixture_only | disapproved_for_human_fpr | suggestion_for_new_entry",
                    "reason": "review rationale",
                    "suggested_fix": "next action or null",
                },
                "attack_c_use": "synthetic_fixture_only | blocked_until_provenance_or_reference_upgrade",
            },
            indent=2,
        ),
        "```",
        "",
        "## Smoke Results",
        "",
        f"- JSON parse: `{summary['smoke_result']['json_parse']}`",
        f"- Required fields: `{summary['smoke_result']['required_fields']}`",
        f"- Unique IDs: `{summary['smoke_result']['unique_ids']}`",
        f"- JSONL written: `{summary['smoke_result']['attack_c_jsonl_written']}`",
        "",
        "## Provenance Counts",
        "",
        format_count_table(summary["counts"]["provenance_tier"]),
        "## Review Status Counts",
        "",
        format_count_table(summary["counts"]["review_status"]),
        "## Coverage Counts",
        "",
        "### Length Bucket",
        "",
        format_count_table(summary["counts"]["length_bucket"]),
        "### Domain",
        "",
        format_count_table(summary["counts"]["domain"]),
        "### Register",
        "",
        format_count_table(summary["counts"]["register"]),
        "## Assessment",
        "",
        "- Approved only for synthetic fixture ingestion and downstream wiring tests.",
        "- Disapproved for human Attack C false-rejection-rate claims until source URLs or source hashes are verified.",
        "- Disapproved for meaningful V5.1 semantic scoring until rows include `reference_answer` or map to prompt-catalog IDs with references.",
        "- Needs long-bucket DAO governance rows; current artifact has only `short` and `medium` items.",
        "",
        "## Forwardable Review Format",
        "",
        "Use this format when asking another model to approve, disapprove, or propose replacements:",
        "",
        "```json",
        json.dumps(
            {
                "review_status": "approved | disapproved | suggestion_for_new_entry",
                "id": "item id or proposed id",
                "scope": "synthetic_fixture | human_fpr | v51_scoring",
                "reason": "short evidence-grounded reason",
                "suggested_fix": "verification, relabeling, reference answer, or replacement row",
                "item": {"id": "example", "prompt": "...", "human_answer": "..."},
            },
            indent=2,
        ),
        "```",
        "",
        "### Example: Approved",
        "",
        "```json",
        json.dumps(approved_sample, indent=2),
        "```",
        "",
        "### Example: Disapproved",
        "",
        "```json",
        json.dumps(disapproved_sample, indent=2),
        "```",
        "",
        "### Example: Suggestion For New Entry",
        "",
        "```json",
        json.dumps(suggestion_sample, indent=2),
        "```",
        "",
        "## Next-Level Sample",
        "",
        "A valid next-level sample should add verified DAO source material and a scorer reference, then keep the synthetic fixture separate from any human-FPR denominator. For the current fixture, run only parser/schema and harness-wiring checks, not headline FPR reporting.",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert Grok artifacts into an Attack C JSONL fixture.")
    parser.add_argument("--artifact", type=Path, action="append", required=True)
    parser.add_argument("--out-jsonl", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--summary-out", type=Path, default=DEFAULT_SUMMARY)
    parser.add_argument("--report-out", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    artifact_paths = [path.resolve() for path in args.artifact]
    items: list[dict[str, Any]] = []
    for path in artifact_paths:
        loaded = load_jsonish(path)
        for idx, item in enumerate(loaded, start=1):
            normalized = normalize_item(item, path, idx)
            items.append(normalized)

    out_jsonl = args.out_jsonl if args.out_jsonl.is_absolute() else (REPO_ROOT / args.out_jsonl)
    summary_out = args.summary_out if args.summary_out.is_absolute() else (REPO_ROOT / args.summary_out)
    report_out = args.report_out if args.report_out.is_absolute() else (REPO_ROOT / args.report_out)

    write_jsonl(items, out_jsonl)
    summary = build_summary(items, artifact_paths, out_jsonl)
    write_summary(summary, summary_out)
    write_report(items, summary, report_out)

    print(f"Tabulated items: {len(items)}")
    print(f"JSONL: {repo_relative(out_jsonl)}")
    print(f"Summary: {repo_relative(summary_out)}")
    print(f"Report: {repo_relative(report_out)}")
    print(json.dumps(summary["smoke_result"], indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
