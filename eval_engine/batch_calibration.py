"""
batch_calibration.py - single-pass calibration data collector.

Runs the configured attacker tiers across the calibration configuration,
collecting full component data in one pass per tier. Writes:
  - raw stdout capture for each tier
  - a consolidated CSV of daily component metrics
  - a summary markdown report
  - a resumable checkpoint for tier-level restarts
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path


ATTACKER_TIERS = ["honest", "basic", "fluent", "intermediate", "advanced", "mechanical"]
DAYS = 3
SUBMISSIONS_PER_DAY = 10
BASE_REWARD = 2000
BURN = 800

OUTPUT_DIR = Path("calibration_results")
TIMESTAMP = datetime.now().strftime("%Y%m%d_%H%M%S")

_DAILY_ROW_RE = re.compile(
    r"^\s*(?P<day>\d+)\s+"
    r"(?P<attempts>\d+)\s+"
    r"(?P<passes>\d+)\s+"
    r"(?P<pass_rate>\d+\.\d+)\s+"
    r"(?P<avg_score>\d+\.\d+)\s+"
    r"(?P<daily_ev>[-\d,]+)\s+"
    r"(?P<cumulative_ev>[-\d,]+)\s+"
    r"(?P<length_compliance>\d+\.\d+)\s+"
    r"(?P<keyword_relevance>\d+\.\d+)\s+"
    r"(?P<semantic_coherence>\d+\.\d+)\s+"
    r"(?P<non_degeneracy>\d+\.\d+)\s*$"
)


def ensure_output_dir() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)


def checkpoint_path_for(run_id: str) -> Path:
    return OUTPUT_DIR / f"checkpoint_{run_id}.json"


def summary_path_for(run_id: str) -> Path:
    return OUTPUT_DIR / f"BATCH_SUMMARY_{run_id}.md"


def csv_path_for(run_id: str) -> Path:
    return OUTPUT_DIR / f"CALIBRATION_COMPONENTS_{run_id}.csv"


def config_snapshot() -> dict[str, object]:
    return {
        "days": DAYS,
        "submissions_per_day": SUBMISSIONS_PER_DAY,
        "base_reward": BASE_REWARD,
        "burn": BURN,
        "attacker_tiers": ATTACKER_TIERS,
    }


def parse_daily_rows(raw_output: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for line in raw_output.splitlines():
        match = _DAILY_ROW_RE.match(line)
        if match:
            rows.append(match.groupdict())
    return rows


def _safe_print(text: str, stream=None) -> None:
    stream = stream or sys.stdout
    encoding = getattr(stream, "encoding", None) or "utf-8"
    sanitized = text.encode(encoding, errors="replace").decode(encoding, errors="replace")
    print(sanitized, file=stream)


def ordered_results(results_by_tier: dict[str, dict]) -> list[dict]:
    return [results_by_tier[tier] for tier in ATTACKER_TIERS if tier in results_by_tier]


def save_checkpoint(state: dict, checkpoint_path: Path) -> None:
    state["last_updated"] = datetime.now().isoformat()
    with checkpoint_path.open("w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2)


def new_checkpoint_state(run_id: str) -> dict:
    now = datetime.now().isoformat()
    return {
        "run_id": run_id,
        "config": config_snapshot(),
        "started_at": now,
        "last_updated": now,
        "completed_tiers": [],
        "results": {},
        "in_progress": None,
    }


def load_checkpoint(checkpoint_path: Path) -> dict:
    with checkpoint_path.open(encoding="utf-8") as handle:
        state = json.load(handle)

    expected = config_snapshot()
    actual = state.get("config", {})
    if actual != expected:
        raise RuntimeError(
            "Checkpoint configuration does not match current batch settings. "
            f"Expected {expected}, found {actual}."
        )

    state.setdefault("run_id", checkpoint_path.stem.replace("checkpoint_", "", 1))
    state.setdefault("completed_tiers", [])
    state.setdefault("results", {})
    state.setdefault("in_progress", None)
    return state


def run_tier(tier: str, run_id: str) -> dict:
    """Run one attacker tier and capture raw output plus parsed daily rows."""
    print(f"\n{'=' * 60}")
    print(f"Running tier: {tier}")
    print(f"{'=' * 60}")

    result = subprocess.run(
        [
            sys.executable,
            "run_epoch.py",
            "--tier",
            tier,
            "--days",
            str(DAYS),
            "--submissions-per-day",
            str(SUBMISSIONS_PER_DAY),
            "--burn",
            str(BURN),
            "--base-reward",
            str(BASE_REWARD),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    output_path = OUTPUT_DIR / f"{tier}_{run_id}.txt"
    stdout = result.stdout or ""
    stderr = result.stderr or ""

    with open(output_path, "w", encoding="utf-8") as handle:
        handle.write(stdout)
        if stderr:
            handle.write("\n\nSTDERR:\n")
            handle.write(stderr)

    _safe_print(stdout)
    if stderr:
        print("STDERR:")
        _safe_print(stderr, stream=sys.stderr)

    tier_result = {
        "tier": tier,
        "output_path": str(output_path),
        "raw_output": stdout,
        "returncode": result.returncode,
        "daily_rows": parse_daily_rows(stdout),
    }
    if result.returncode != 0:
        tier_result["error"] = f"run_epoch.py exited with status {result.returncode}"
    return tier_result


def write_csv(results: list[dict], csv_path: Path) -> None:
    fieldnames = [
        "tier",
        "day",
        "attempts",
        "passes",
        "pass_rate",
        "avg_score",
        "daily_ev",
        "cumulative_ev",
        "length_compliance",
        "keyword_relevance",
        "semantic_coherence",
        "non_degeneracy",
    ]

    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for result in results:
            for row in result.get("daily_rows", []):
                writer.writerow({"tier": result["tier"], **row})


def write_summary(results: list[dict], summary_path: Path, csv_path: Path, run_id: str) -> None:
    with summary_path.open("w", encoding="utf-8") as handle:
        handle.write(f"# Batch calibration {run_id}\n\n")
        handle.write(
            "Configuration: "
            f"days={DAYS}, burn={BURN}, reward={BASE_REWARD}, "
            f"sub/day={SUBMISSIONS_PER_DAY}\n\n"
        )
        handle.write("## Outputs\n\n")
        handle.write(f"- Consolidated CSV: `{csv_path.name}`\n")
        for result in results:
            handle.write(f"- `{result['tier']}` raw output: `{Path(result['output_path']).name}`\n")
            if "error" in result:
                handle.write(f"  ERROR: {result['error']}\n")

        handle.write("\n## Daily component averages\n\n")
        for result in results:
            handle.write(f"### {result['tier']}\n\n")
            rows = result.get("daily_rows", [])
            if not rows:
                handle.write("No daily rows parsed from report output.\n\n")
                continue

            handle.write("| Day | PassRate | AvgScore | Len | Kw | Sem | Deg |\n")
            handle.write("| --- | --- | --- | --- | --- | --- | --- |\n")
            for row in rows:
                handle.write(
                    f"| {row['day']} | {row['pass_rate']} | {row['avg_score']} | "
                    f"{row['length_compliance']} | {row['keyword_relevance']} | "
                    f"{row['semantic_coherence']} | {row['non_degeneracy']} |\n"
                )
            handle.write("\n")

        handle.write("## What to look for\n\n")
        handle.write(
            "Under v5.0, semantic_coherence is contrastive rather than raw cosine. "
            "The key question is whether the mechanical tier's semantic average "
            "stays materially below the other filler-heavy tiers while still "
            "leaving room for curated honest baselines.\n\n"
        )
        handle.write("Calibration notes:\n")
        handle.write(
            "- `honest` in this harness does not see hidden prompts, so it is "
            "not a valid hidden-prompt pass-threshold benchmark.\n"
        )
        handle.write(
            "- Use `prompts/honest_baseline_pub_001_010.json` or a dedicated "
            "visible-prompt harness for honest-user threshold calibration.\n"
        )
        handle.write(
            "- Include `mechanical` in every v5.0 sweep; it is the primary "
            "attacker this contrastive defense is designed to suppress.\n"
        )
        handle.write(
            "- Do not reuse the v4.x Delta-Semantic threshold rules. Recompute "
            "thresholds from fresh v5.0 score distributions.\n"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--resume",
        type=Path,
        default=None,
        help="Resume a previous batch run from a checkpoint file.",
    )
    args = parser.parse_args()

    ensure_output_dir()

    if args.resume is not None:
        checkpoint_path = args.resume
        if not checkpoint_path.exists():
            raise RuntimeError(f"Checkpoint not found: {checkpoint_path}")
        state = load_checkpoint(checkpoint_path)
        run_id = state["run_id"]
        completed_tiers = set(state.get("completed_tiers", []))
        in_progress = state.get("in_progress")
        print("Batch calibration resuming")
        print(f"Checkpoint: {checkpoint_path.resolve()}")
        print(f"Completed tiers: {sorted(completed_tiers)}")
        if in_progress:
            print(f"Re-running interrupted tier: {in_progress.get('tier')}")
    else:
        run_id = TIMESTAMP
        checkpoint_path = checkpoint_path_for(run_id)
        state = new_checkpoint_state(run_id)
        completed_tiers = set()
        save_checkpoint(state, checkpoint_path)
        print("Batch calibration starting")

    summary_path = summary_path_for(run_id)
    csv_path = csv_path_for(run_id)

    print(f"Tiers: {ATTACKER_TIERS}")
    print(f"Days: {DAYS}, Burn: {BURN}, Reward: {BASE_REWARD}")
    print(f"Submissions per day: {SUBMISSIONS_PER_DAY}")
    print(f"Output dir: {OUTPUT_DIR.resolve()}")
    print(f"Checkpoint: {checkpoint_path.resolve()}")

    results_by_tier: dict[str, dict] = dict(state.get("results", {}))
    for tier in ATTACKER_TIERS:
        if tier in completed_tiers:
            print(f"Skipping {tier} - already complete")
            continue

        state["in_progress"] = {
            "tier": tier,
            "started_at": datetime.now().isoformat(),
        }
        save_checkpoint(state, checkpoint_path)

        try:
            tier_result = run_tier(tier, run_id)
        except Exception as exc:
            save_checkpoint(state, checkpoint_path)
            print(f"ERROR running {tier}: {exc}")
            print(f"Resume with: python batch_calibration.py --resume {checkpoint_path}")
            raise

        if tier_result["returncode"] != 0:
            results_by_tier[tier] = tier_result
            state["results"] = results_by_tier
            save_checkpoint(state, checkpoint_path)
            print(f"Tier {tier} failed with return code {tier_result['returncode']}.")
            print(f"Resume with: python batch_calibration.py --resume {checkpoint_path}")
            raise RuntimeError(tier_result["error"])

        results_by_tier[tier] = tier_result
        state["results"] = results_by_tier
        if tier not in state["completed_tiers"]:
            state["completed_tiers"].append(tier)
        state["in_progress"] = None
        completed_tiers.add(tier)
        save_checkpoint(state, checkpoint_path)

    results = ordered_results(results_by_tier)
    write_csv(results, csv_path)
    write_summary(results, summary_path, csv_path, run_id)

    state["finished_at"] = datetime.now().isoformat()
    save_checkpoint(state, checkpoint_path)

    print(f"\n{'=' * 60}")
    print(f"Batch complete. Summary: {summary_path}")
    print(f"CSV: {csv_path}")
    print(f"Checkpoint: {checkpoint_path}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
