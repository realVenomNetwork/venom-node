#!/usr/bin/env python3
"""Validate the Project Alignment V1 structural contract."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class Finding:
    severity: str
    message: str
    path: str | None = None


def add(findings: list[Finding], severity: str, message: str, path: Path | None = None) -> None:
    findings.append(Finding(severity=severity, message=message, path=str(path) if path else None))


def check_required_files(root: Path, findings: list[Finding]) -> None:
    required = [
        root / "README.md",
        root / "PROJECT_ALIGNMENT_V1.md",
        root / ".env.example",
        root / "docs" / "oracles" / "README.md",
        root / "docs" / "oracles" / "LANE_REGISTRY.json",
        root / "docs" / "oracles" / "STATUS.md",
        root / "docs" / "oracles" / "oracle_a_gemini_public.md",
        root / "docs" / "oracles" / "oracle_b_claude_public.md",
        root / "docs" / "oracles" / "oracle_c_gpt_public.md",
        root / "docs" / "oracles" / "worker_gemini_public.md",
        root / "docs" / "oracles" / "worker_claude_public.md",
        root / "docs" / "oracles" / "worker_gpt_codex_public.md",
        root / "docs" / "oracles" / "worker_grok_public.md",
        root / "docs" / "campaigns" / "README.md",
        root / "docs" / "campaigns" / "initiative_rotation.json",
        root / "docs" / "campaigns" / "002" / "bundle.md",
        root / "docs" / "campaigns" / "002" / "close_manifest.json",
        root / "docs" / "campaigns" / "002" / "model_preferences.json",
        root / "docs" / "campaigns" / "002" / "rubric.json",
        root / "docs" / "campaigns" / "002" / "rubric_report.json",
        root / "docs" / "campaigns" / "002" / "rubric_results_input.json",
        root / "docs" / "campaigns" / "002" / "spec.json",
        root / "docs" / "campaigns" / "002" / "tx_hashes.json",
        root / "docs" / "campaigns" / "002" / "worker_output.md",
        root / "docs" / "campaigns" / "003" / "bundle.md",
        root / "docs" / "campaigns" / "003" / "close_manifest.json",
        root / "docs" / "campaigns" / "003" / "model_preferences.json",
        root / "docs" / "campaigns" / "003" / "rubric.json",
        root / "docs" / "campaigns" / "003" / "rubric_report.json",
        root / "docs" / "campaigns" / "003" / "rubric_results_input.json",
        root / "docs" / "campaigns" / "003" / "spec.json",
        root / "docs" / "campaigns" / "003" / "tx_hashes.json",
        root / "docs" / "campaigns" / "003" / "worker_output.md",
        root / "docs" / "campaigns" / "004" / "bundle.md",
        root / "docs" / "campaigns" / "004" / "close_manifest.json",
        root / "docs" / "campaigns" / "004" / "model_preferences.json",
        root / "docs" / "campaigns" / "004" / "rubric.json",
        root / "docs" / "campaigns" / "004" / "rubric_report.json",
        root / "docs" / "campaigns" / "004" / "rubric_results_input.json",
        root / "docs" / "campaigns" / "004" / "spec.json",
        root / "docs" / "campaigns" / "004" / "tx_hashes.json",
        root / "docs" / "campaigns" / "004" / "worker_output.md",
        root / "docs" / "campaigns" / "005" / "bundle.md",
        root / "docs" / "campaigns" / "005" / "close_manifest.json",
        root / "docs" / "campaigns" / "005" / "model_preferences.json",
        root / "docs" / "campaigns" / "005" / "rubric.json",
        root / "docs" / "campaigns" / "005" / "rubric_report.json",
        root / "docs" / "campaigns" / "005" / "rubric_results_input.json",
        root / "docs" / "campaigns" / "005" / "spec.json",
        root / "docs" / "campaigns" / "005" / "tx_hashes.json",
        root / "docs" / "campaigns" / "005" / "worker_output.md",
        root / "docs" / "campaigns" / "006" / "bundle.md",
        root / "docs" / "campaigns" / "006" / "close_manifest.json",
        root / "docs" / "campaigns" / "006" / "model_preferences.json",
        root / "docs" / "campaigns" / "006" / "rubric.json",
        root / "docs" / "campaigns" / "006" / "rubric_report.json",
        root / "docs" / "campaigns" / "006" / "rubric_results_input.json",
        root / "docs" / "campaigns" / "006" / "spec.json",
        root / "docs" / "campaigns" / "006" / "tx_hashes.json",
        root / "docs" / "campaigns" / "006" / "worker_output.md",
        root / "docs" / "campaigns" / "007" / "bundle.md",
        root / "docs" / "campaigns" / "007" / "close_manifest.json",
        root / "docs" / "campaigns" / "007" / "model_preferences.json",
        root / "docs" / "campaigns" / "007" / "rubric.json",
        root / "docs" / "campaigns" / "007" / "rubric_report.json",
        root / "docs" / "campaigns" / "007" / "rubric_results_input.json",
        root / "docs" / "campaigns" / "007" / "spec.json",
        root / "docs" / "campaigns" / "007" / "tx_hashes.json",
        root / "docs" / "campaigns" / "007" / "worker_output.md",
        root / "tools" / "validate_project_alignment.py",
        root / "tools" / "pilot_readiness_lint.py",
        root / "tools" / "oracle_scripts" / "sign_pilot_payload.js",
        root / "tools" / "campaign_scripts" / "draft_campaign_uid.js",
        root / "tools" / "campaign_scripts" / "fund_campaign.js",
        root / "tools" / "campaign_scripts" / "hash_close_payload.js",
        root / "tools" / "campaign_scripts" / "close_campaign.js",
        root / "tools" / "registry" / "README.md",
        root / "tools" / "registry" / "register_lane_eoa.js",
        root / "tools" / "setup" / "README.md",
    ]
    for path in required:
        if not path.exists():
            add(findings, "FAIL", "required file missing", path)


def check_no_nested_seed(root: Path, findings: list[Finding]) -> None:
    nested = root / "seed"
    if nested.exists():
        add(findings, "FAIL", "nested seed directory still exists", nested)


def check_model_dirs(root: Path, findings: list[Finding]) -> None:
    for name in ("gemini", "claude", "gpt", "grok"):
        folder = root / name
        if folder.exists():
            add(findings, "FAIL", "per-model folder still exists after consolidation", folder)


def check_campaign_layout(root: Path, findings: list[Finding]) -> None:
    campaign_dir = root / "docs" / "campaigns" / "001"
    required = {
        "bundle.md",
        "claude_source_check.md",
        "close_manifest.json",
        "rubric.json",
        "rubric_report.json",
        "rubric_results_input.json",
        "spec.json",
        "tx_hashes.json",
        "worker_output.md",
    }
    if not campaign_dir.exists():
        add(findings, "FAIL", "Campaign 001 directory missing", campaign_dir)
        return
    actual = {path.name for path in campaign_dir.iterdir() if path.is_file()}
    missing = sorted(required - actual)
    if missing:
        add(findings, "FAIL", f"Campaign 001 missing required files: {', '.join(missing)}", campaign_dir)

    campaign2_dir = root / "docs" / "campaigns" / "002"
    campaign2_required = {
        "bundle.md",
        "close_manifest.json",
        "model_preferences.json",
        "rubric.json",
        "rubric_report.json",
        "rubric_results_input.json",
        "spec.json",
        "tx_hashes.json",
        "worker_output.md",
    }
    if not campaign2_dir.exists():
        add(findings, "FAIL", "Campaign 002 directory missing", campaign2_dir)
        return
    campaign2_actual = {path.name for path in campaign2_dir.iterdir() if path.is_file()}
    campaign2_missing = sorted(campaign2_required - campaign2_actual)
    if campaign2_missing:
        add(findings, "FAIL", f"Campaign 002 missing expected files: {', '.join(campaign2_missing)}", campaign2_dir)

    campaign3_dir = root / "docs" / "campaigns" / "003"
    campaign3_required = {
        "bundle.md",
        "close_manifest.json",
        "model_preferences.json",
        "rubric.json",
        "rubric_report.json",
        "rubric_results_input.json",
        "spec.json",
        "tx_hashes.json",
        "worker_output.md",
    }
    if not campaign3_dir.exists():
        add(findings, "FAIL", "Campaign 003 directory missing", campaign3_dir)
        return
    campaign3_actual = {path.name for path in campaign3_dir.iterdir() if path.is_file()}
    campaign3_missing = sorted(campaign3_required - campaign3_actual)
    if campaign3_missing:
        add(findings, "FAIL", f"Campaign 003 missing expected files: {', '.join(campaign3_missing)}", campaign3_dir)

    campaign4_dir = root / "docs" / "campaigns" / "004"
    campaign4_required = {
        "bundle.md",
        "close_manifest.json",
        "model_preferences.json",
        "rubric.json",
        "rubric_report.json",
        "rubric_results_input.json",
        "spec.json",
        "tx_hashes.json",
        "worker_output.md",
    }
    if not campaign4_dir.exists():
        add(findings, "FAIL", "Campaign 004 directory missing", campaign4_dir)
        return
    campaign4_actual = {path.name for path in campaign4_dir.iterdir() if path.is_file()}
    campaign4_missing = sorted(campaign4_required - campaign4_actual)
    if campaign4_missing:
        add(findings, "FAIL", f"Campaign 004 missing expected files: {', '.join(campaign4_missing)}", campaign4_dir)

    campaign5_dir = root / "docs" / "campaigns" / "005"
    campaign5_required = {
        "bundle.md",
        "close_manifest.json",
        "model_preferences.json",
        "rubric.json",
        "rubric_report.json",
        "rubric_results_input.json",
        "spec.json",
        "tx_hashes.json",
        "worker_output.md",
    }
    if not campaign5_dir.exists():
        add(findings, "FAIL", "Campaign 005 directory missing", campaign5_dir)
        return
    campaign5_actual = {path.name for path in campaign5_dir.iterdir() if path.is_file()}
    campaign5_missing = sorted(campaign5_required - campaign5_actual)
    if campaign5_missing:
        add(findings, "FAIL", f"Campaign 005 missing expected files: {', '.join(campaign5_missing)}", campaign5_dir)

    campaign6_dir = root / "docs" / "campaigns" / "006"
    campaign6_required = {
        "bundle.md",
        "close_manifest.json",
        "model_preferences.json",
        "rubric.json",
        "rubric_report.json",
        "rubric_results_input.json",
        "spec.json",
        "tx_hashes.json",
        "worker_output.md",
    }
    if not campaign6_dir.exists():
        add(findings, "FAIL", "Campaign 006 directory missing", campaign6_dir)
        return
    campaign6_actual = {path.name for path in campaign6_dir.iterdir() if path.is_file()}
    campaign6_missing = sorted(campaign6_required - campaign6_actual)
    if campaign6_missing:
        add(findings, "FAIL", f"Campaign 006 missing expected files: {', '.join(campaign6_missing)}", campaign6_dir)

    campaign7_dir = root / "docs" / "campaigns" / "007"
    campaign7_required = {
        "bundle.md",
        "close_manifest.json",
        "model_preferences.json",
        "rubric.json",
        "rubric_report.json",
        "rubric_results_input.json",
        "spec.json",
        "tx_hashes.json",
        "worker_output.md",
    }
    if not campaign7_dir.exists():
        add(findings, "FAIL", "Campaign 007 directory missing", campaign7_dir)
        return
    campaign7_actual = {path.name for path in campaign7_dir.iterdir() if path.is_file()}
    campaign7_missing = sorted(campaign7_required - campaign7_actual)
    if campaign7_missing:
        add(findings, "FAIL", f"Campaign 007 missing expected files: {', '.join(campaign7_missing)}", campaign7_dir)


def check_lane_registry(root: Path, findings: list[Finding]) -> None:
    path = root / "docs" / "oracles" / "LANE_REGISTRY.json"
    if not path.exists():
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    lanes = data.get("lanes", {})
    for lane_id in ("gemini", "claude", "gpt_codex", "grok"):
        if lane_id not in lanes:
            add(findings, "FAIL", f"lane registry missing {lane_id}", path)
    if lanes.get("grok", {}).get("oracle") is not None:
        add(findings, "FAIL", "lane registry still mislabels Grok as an oracle", path)


def check_env_standard(root: Path, findings: list[Finding]) -> None:
    path = root / ".env.example"
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    required = [
        "STAKEHOLDER_PRIVATE_KEY",
        "BROADCASTER_PRIVATE_KEY",
        "ORACLE_A_PRIVATE_KEY",
        "ORACLE_B_PRIVATE_KEY",
        "ORACLE_C_PRIVATE_KEY",
        "WORKER_GEMINI_PRIVATE_KEY",
        "WORKER_CLAUDE_PRIVATE_KEY",
        "WORKER_GPT_CODEX_PRIVATE_KEY",
        "WORKER_GROK_PRIVATE_KEY",
        "WORKER_PRIVATE_KEY",
    ]
    for token in required:
        if token not in text:
            add(findings, "FAIL", f".env.example missing {token}", path)
    if "ORACLE_GROK_PRIVATE_KEY" in text:
        add(findings, "FAIL", ".env.example still mislabels Grok as an oracle", path)


def check_legacy_tooling_removed(root: Path, findings: list[Finding]) -> None:
    forbidden = [
        root / "tools" / "oracle_scripts" / "generateOracleASig.js",
        root / "tools" / "oracle_scripts" / "generateOracleBSig.js",
        root / "tools" / "oracle_scripts" / "generateOracleCSig.js",
        root / "tools" / "oracle_scripts" / "dryrun_close.js",
        root / "tools" / "campaign_scripts" / "draft_sip518_bounty.js",
        root / "tools" / "campaign_scripts" / "fund_sip518.js",
    ]
    for path in forbidden:
        if path.exists():
            add(findings, "FAIL", "legacy live-toolchain file still present", path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    findings: list[Finding] = []

    check_required_files(root, findings)
    check_no_nested_seed(root, findings)
    check_model_dirs(root, findings)
    check_campaign_layout(root, findings)
    check_lane_registry(root, findings)
    check_env_standard(root, findings)
    check_legacy_tooling_removed(root, findings)

    if args.json:
        print(json.dumps([asdict(finding) for finding in findings], indent=2, sort_keys=True))
    else:
        if not findings:
            print("PASS: project alignment structure is valid")
        for finding in findings:
            location = f" [{finding.path}]" if finding.path else ""
            print(f"{finding.severity}: {finding.message}{location}")

    return 1 if any(f.severity == "FAIL" for f in findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
