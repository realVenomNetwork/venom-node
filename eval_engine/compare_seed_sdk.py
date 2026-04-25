#!/usr/bin/env python3
"""Compare the compact shared seed tree against the working attacker_sdk tree."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


DEFAULT_EXCLUDE_DIRS = {
    ".git",
    ".pytest_cache",
    "__pycache__",
    "artifacts",
    "cache",
    "coverage",
    "node_modules",
    "out",
}


def default_sdk_root() -> Path:
    return Path(__file__).resolve().parents[3] / "attacker_sdk"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def excluded(rel: Path, *, include_generated: bool) -> bool:
    parts = set(rel.parts)
    if parts & DEFAULT_EXCLUDE_DIRS:
        return True
    if rel.suffix.lower() == ".pyc":
        return True
    if not include_generated and len(rel.parts) >= 2:
        if rel.parts[0] == "attack_runs" and rel.parts[1] == "attack_b":
            return True
    return False


def collect(root: Path, *, include_generated: bool) -> dict[str, dict[str, Any]]:
    files: dict[str, dict[str, Any]] = {}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if excluded(rel, include_generated=include_generated):
            continue
        rel_key = rel.as_posix()
        files[rel_key] = {"sha256": sha256_file(path), "bytes": path.stat().st_size}
    return files


def compare(seed_root: Path, sdk_root: Path, *, include_generated: bool) -> dict[str, Any]:
    seed_files = collect(seed_root, include_generated=include_generated)
    sdk_files = collect(sdk_root, include_generated=include_generated)

    seed_keys = set(seed_files)
    sdk_keys = set(sdk_files)
    shared = sorted(seed_keys & sdk_keys)
    different = [rel for rel in shared if seed_files[rel]["sha256"] != sdk_files[rel]["sha256"]]
    identical = [rel for rel in shared if rel not in different]

    return {
        "seed_root": str(seed_root),
        "sdk_root": str(sdk_root),
        "counts": {
            "seed_files": len(seed_files),
            "sdk_files": len(sdk_files),
            "shared_identical": len(identical),
            "shared_different": len(different),
            "seed_only": len(seed_keys - sdk_keys),
            "sdk_only": len(sdk_keys - seed_keys),
        },
        "shared_different": different,
        "seed_only": sorted(seed_keys - sdk_keys),
        "sdk_only": sorted(sdk_keys - seed_keys),
    }


def print_list(title: str, rows: list[str], limit: int) -> None:
    print(f"\n{title} ({len(rows)})")
    shown = rows if limit == 0 else rows[:limit]
    for row in shown:
        print(f"  {row}")
    if limit and len(rows) > limit:
        print(f"  ... {len(rows) - limit} more")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--seed-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Compact shared seed root.",
    )
    parser.add_argument(
        "--sdk-root",
        type=Path,
        default=default_sdk_root(),
        help="Working attacker_sdk root.",
    )
    parser.add_argument("--include-generated", action="store_true")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    parser.add_argument("--limit", type=int, default=40, help="Rows per list; 0 means no limit.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    seed_root = args.seed_root.resolve()
    sdk_root = args.sdk_root.resolve()
    if not seed_root.exists():
        raise FileNotFoundError(f"seed root not found: {seed_root}")
    if not sdk_root.exists():
        raise FileNotFoundError(f"attacker_sdk root not found: {sdk_root}")

    report = compare(seed_root, sdk_root, include_generated=args.include_generated)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0

    print(f"seed root: {report['seed_root']}")
    print(f"sdk root:  {report['sdk_root']}")
    for key, value in report["counts"].items():
        print(f"{key}: {value}")
    print_list("shared files with different content", report["shared_different"], args.limit)
    print_list("seed-only files", report["seed_only"], args.limit)
    print_list("sdk-only files", report["sdk_only"], args.limit)
    return 1 if report["shared_different"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
