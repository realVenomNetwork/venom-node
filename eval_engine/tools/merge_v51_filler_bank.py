"""
Merge the v5.1 candidate contrastive filler bank.

The script is intentionally strict: it refuses to write the output unless the
expected 5 original + 5 Claude + 4 Gemini + 5 GPT-5.3 distinct patterns are
present and traceable by id prefix.
"""

from __future__ import annotations

import argparse
import json
import re
from copy import deepcopy
from datetime import date
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ORIGINAL = REPO_ROOT / "data" / "prompts" / "v5_contrastive_filler_bank.json"
DEFAULT_OUTPUT = REPO_ROOT / "data" / "prompts" / "v5.1_contrastive_filler_bank.json"

REFERENCE_ROOT = REPO_ROOT.parent
DEFAULT_CLAUDE = REFERENCE_ROOT / "v5_filler_bank_additions.json"
DEFAULT_GEMINI = REFERENCE_ROOT / "Gemini-Native-Filler-Patterns.txt"
DEFAULT_GPT53 = REFERENCE_ROOT / "filler_gpt53.json"

EXPECTED_COUNTS = {
    "original": 5,
    "claude": 5,
    "gemini": 4,
    "gpt53": 5,
}


class MergeError(RuntimeError):
    pass


def load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise MergeError(f"{path} is not valid JSON: {exc}") from exc


def require_entries(payload: dict[str, Any], path: Path) -> list[dict[str, Any]]:
    entries = payload.get("filler_bank")
    if entries is None:
        entries = payload.get("filler_bank_additions")
    if not isinstance(entries, list):
        raise MergeError(f"{path} does not contain filler_bank or filler_bank_additions.")
    return [dict(entry) for entry in entries]


def normalize_entry(entry: dict[str, Any], *, origin: str, new_id: str | None = None) -> dict[str, Any]:
    entry_id = str(entry.get("id", "")).strip()
    text = str(entry.get("text", "")).strip()
    if not entry_id or not text:
        raise MergeError(f"{origin} entry is missing id or text: {entry!r}")

    normalized = dict(entry)
    normalized["original_id"] = entry_id
    normalized["id"] = new_id or entry_id
    normalized["origin"] = origin
    normalized["text"] = text
    return normalized


def original_entries(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    payload = load_json(path)
    entries = [
        normalize_entry(entry, origin="original")
        for entry in require_entries(payload, path)
    ]
    return payload, entries


def claude_entries(path: Path) -> list[dict[str, Any]]:
    payload = load_json(path)
    entries = []
    for entry in require_entries(payload, path):
        entry_id = str(entry.get("id", "")).strip()
        if not entry_id.startswith("filler_"):
            raise MergeError(f"Claude entry id must start with filler_: {entry_id}")
        suffix = entry_id.removeprefix("filler_")
        entries.append(
            normalize_entry(
                entry,
                origin="claude",
                new_id=f"filler_claude_{suffix}",
            )
        )
    return entries


TEXT_PATTERN = re.compile(r'^(filler_[A-Za-z0-9_]+):\s*"(.+)"\s*$')


def text_entries(path: Path, *, origin: str, required_prefix: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        match = TEXT_PATTERN.match(line)
        if not match:
            continue
        entry_id, text = match.groups()
        if not entry_id.startswith(required_prefix):
            raise MergeError(
                f"{origin} entry id {entry_id} does not start with {required_prefix}."
            )
        entries.append(
            normalize_entry(
                {"id": entry_id, "pattern": entry_id.removeprefix("filler_"), "text": text},
                origin=origin,
            )
        )
    return entries


def gpt53_entries(path: Path) -> list[dict[str, Any]]:
    raw = path.read_text(encoding="utf-8")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return text_entries(path, origin="gpt53", required_prefix="filler_gpt53_")

    entries = []
    for entry in require_entries(payload, path):
        entry_id = str(entry.get("id", "")).strip()
        if not entry_id.startswith("filler_gpt53_"):
            raise MergeError(
                f"GPT-5.3 entry id {entry_id} does not start with filler_gpt53_."
            )
        entries.append(normalize_entry(entry, origin="gpt53"))
    return entries


def validate_counts(groups: dict[str, list[dict[str, Any]]]) -> None:
    for origin, expected in EXPECTED_COUNTS.items():
        actual = len(groups.get(origin, []))
        if actual != expected:
            raise MergeError(f"Expected {expected} {origin} entries, found {actual}.")


def validate_distinct(entries: list[dict[str, Any]]) -> None:
    seen_ids: dict[str, str] = {}
    seen_texts: dict[str, str] = {}
    for entry in entries:
        entry_id = entry["id"]
        lowered_text = re.sub(r"\s+", " ", entry["text"].strip().lower())
        if entry_id in seen_ids:
            raise MergeError(f"Duplicate filler id {entry_id} from {entry['origin']}.")
        if lowered_text in seen_texts:
            raise MergeError(
                f"Duplicate filler text between {seen_texts[lowered_text]} and {entry_id}."
            )
        seen_ids[entry_id] = entry["origin"]
        seen_texts[lowered_text] = entry_id


def build_payload(original_payload: dict[str, Any], groups: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    merged = (
        groups["original"]
        + groups["claude"]
        + groups["gemini"]
        + groups["gpt53"]
    )
    payload = {
        "meta": {
            "version": "5.1-candidate",
            "purpose": "Expanded contrastive semantic scoring filler bank for bounded Epoch 2 re-verification",
            "date": date.today().isoformat(),
            "status": "candidate_pending_bounded_reverification",
            "parent_document": "prompts/v5_contrastive_filler_bank.json",
            "source_counts": {origin: len(entries) for origin, entries in groups.items()},
            "total_patterns": len(merged),
            "pass_threshold_unchanged": 55,
            "notes": [
                "Original v5.0 bank is preserved unchanged.",
                "Claude, Gemini, and GPT-5.3 entries remain traceable by id prefix and origin field.",
                "Lambda and rescale remain at the v5.0 starting values until bounded verification proves whether tuning is needed.",
            ],
        },
        "scoring_formula": deepcopy(original_payload.get("scoring_formula", {})),
        "filler_bank": merged,
    }
    return payload


def merge(args: argparse.Namespace) -> dict[str, Any]:
    original_payload, originals = original_entries(args.original)
    groups = {
        "original": originals,
        "claude": claude_entries(args.claude),
        "gemini": text_entries(args.gemini, origin="gemini", required_prefix="filler_gemini_"),
        "gpt53": gpt53_entries(args.gpt53),
    }
    validate_counts(groups)
    all_entries = [entry for entries in groups.values() for entry in entries]
    validate_distinct(all_entries)
    return build_payload(original_payload, groups)


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge the v5.1 candidate filler bank.")
    parser.add_argument("--original", type=Path, default=DEFAULT_ORIGINAL)
    parser.add_argument("--claude", type=Path, default=DEFAULT_CLAUDE)
    parser.add_argument("--gemini", type=Path, default=DEFAULT_GEMINI)
    parser.add_argument("--gpt53", type=Path, default=DEFAULT_GPT53)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    payload = merge(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {args.output} with {payload['meta']['total_patterns']} filler patterns "
        f"and counts {payload['meta']['source_counts']}."
    )


if __name__ == "__main__":
    try:
        main()
    except MergeError as exc:
        raise SystemExit(f"merge_v51_filler_bank.py: {exc}") from exc
