"""Lightweight prompt-pool integrity audit.

This script intentionally avoids scorer/model imports. It is meant to answer
basic data questions before spending local compute on Attack B or Attack C.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROMPT_FILES = (
    REPO_ROOT / "data" / "prompts" / "public.json",
    REPO_ROOT / "data" / "prompts" / "rotating.json",
)


@dataclass(frozen=True)
class Finding:
    severity: str
    prompt_id: str
    code: str
    detail: str = ""


def load_prompt_records(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        raw = payload.get("prompts", payload.get("items", payload.get("corpus", [])))
    else:
        raw = payload
    if not isinstance(raw, list):
        raise ValueError(f"{path} must contain a list or an object with prompts/items/corpus.")
    return [dict(item) for item in raw]


def audit_record(record: dict[str, Any], *, strict_keywords: bool) -> list[Finding]:
    prompt_id = str(record.get("id", record.get("prompt_id", "<missing id>")))
    prompt = str(record.get("prompt", ""))
    reference = str(record.get("reference_answer", ""))
    keywords = [str(item) for item in record.get("must_contain_any", [])]
    findings: list[Finding] = []

    if not prompt.strip():
        findings.append(Finding("error", prompt_id, "missing_prompt"))
    if not reference.strip():
        findings.append(Finding("error", prompt_id, "missing_reference_answer"))

    words = reference.split()
    min_length = int(record.get("min_length", 0) or 0)
    max_length = int(record.get("max_length", 0) or 0)
    if reference.strip() and min_length and len(words) < min_length:
        findings.append(
            Finding(
                "warning",
                prompt_id,
                "reference_shorter_than_min_length",
                f"{len(words)} < {min_length}",
            )
        )
    if reference.strip() and max_length and len(words) > max_length:
        findings.append(
            Finding(
                "warning",
                prompt_id,
                "reference_longer_than_max_length",
                f"{len(words)} > {max_length}",
            )
        )

    if keywords and reference.strip():
        lower_reference = reference.lower()
        missing = [keyword for keyword in keywords if keyword.lower() not in lower_reference]
        if len(missing) == len(keywords):
            findings.append(
                Finding(
                    "warning",
                    prompt_id,
                    "reference_contains_none_of_must_contain_any",
                    ", ".join(keywords),
                )
            )
        elif strict_keywords and missing:
            findings.append(
                Finding(
                    "warning",
                    prompt_id,
                    "reference_missing_some_keywords",
                    ", ".join(missing),
                )
            )

    return findings


def resolve_path(path: Path) -> Path:
    if path.is_absolute():
        return path
    return (REPO_ROOT / path).resolve()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit prompt JSON without loading evaluator models.")
    parser.add_argument(
        "--prompt-file",
        action="append",
        type=Path,
        default=None,
        help="Prompt JSON file to audit. Defaults to public.json and rotating.json.",
    )
    parser.add_argument(
        "--strict-keywords",
        action="store_true",
        help="Also warn when a reference omits some visible must_contain_any keywords.",
    )
    parser.add_argument(
        "--fail-on-warning",
        action="store_true",
        help="Return non-zero when warnings are present.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    paths = [resolve_path(path) for path in (args.prompt_file or DEFAULT_PROMPT_FILES)]
    total_errors = 0
    total_warnings = 0

    for path in paths:
        records = load_prompt_records(path)
        findings: list[Finding] = []
        for record in records:
            findings.extend(audit_record(record, strict_keywords=args.strict_keywords))

        errors = [finding for finding in findings if finding.severity == "error"]
        warnings = [finding for finding in findings if finding.severity == "warning"]
        total_errors += len(errors)
        total_warnings += len(warnings)

        display = path.relative_to(REPO_ROOT) if path.is_relative_to(REPO_ROOT) else path
        print(f"{display}: {len(records)} prompts, {len(errors)} errors, {len(warnings)} warnings")
        for finding in findings:
            suffix = f" {finding.detail}" if finding.detail else ""
            print(f"  - {finding.severity} {finding.prompt_id}: {finding.code}{suffix}")

    print(f"Prompt integrity audit complete: {total_errors} errors, {total_warnings} warnings")
    if total_errors:
        return 1
    if args.fail_on_warning and total_warnings:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
