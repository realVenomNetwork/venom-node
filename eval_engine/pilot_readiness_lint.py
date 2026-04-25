#!/usr/bin/env python3
"""Lint the post-DR003 seed for pilot handoff gaps raised by the model loop."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path


ORACLE_NAMES = ("Oracle A", "Oracle B", "Oracle C")
PAIR_NAMES = {
    frozenset(("Oracle A", "Oracle B")): "Oracle A + Oracle B",
    frozenset(("Oracle A", "Oracle C")): "Oracle A + Oracle C",
    frozenset(("Oracle B", "Oracle C")): "Oracle B + Oracle C",
}


@dataclass
class Finding:
    severity: str
    topic: str
    message: str
    path: str | None = None
    action: str | None = None


def rel(root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path)


def add(findings: list[Finding], severity: str, topic: str, message: str, path: Path | None = None, action: str | None = None) -> None:
    findings.append(Finding(severity, topic, message, str(path) if path else None, action))


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def parse_used_oracles(text: str) -> frozenset[str] | None:
    match = re.search(r"Signatures Used for Tx:\*\*\s*([^\n\r]+)", text)
    if not match:
        return None
    used = set()
    for name in ORACLE_NAMES:
        if name in match.group(1):
            used.add(name)
    return frozenset(used) if used else None


def check_dryruns(root: Path, findings: list[Finding]) -> None:
    dryrun_dir = root / "docs" / "dryrun"
    docs = sorted(dryrun_dir.glob("v*_dryrun_*.md"))
    if not docs:
        add(findings, "FAIL", "dryrun", "No dry-run docs found.", dryrun_dir)
        return

    used_pairs: set[frozenset[str]] = set()
    for doc in docs:
        text = read_text(doc)
        used = parse_used_oracles(text)
        if used:
            used_pairs.add(used)
        else:
            add(findings, "WARN", "dryrun", "Could not parse signatures used for tx.", doc)
        if "Signatures NOT used" not in text:
            add(findings, "WARN", "dryrun", "Dry-run artifact does not record the unused oracle signature.", doc)
        if "Gas Used" not in text:
            add(findings, "INFO", "dryrun", f"{doc.name} has no gas-used field; add it if the receipt is available.", doc)

    missing_pairs = sorted(set(PAIR_NAMES) - used_pairs, key=lambda item: PAIR_NAMES[item])
    if missing_pairs:
        add(
            findings,
            "WARN",
            "dryrun",
            "Not every 2-of-3 oracle pair has been exercised: " + ", ".join(PAIR_NAMES[p] for p in missing_pairs),
            dryrun_dir,
            "Use the missing pair in the next v1.5 dry-run if practical.",
        )
    else:
        add(findings, "PASS", "dryrun", "All 2-of-3 oracle pairs have at least one dry-run.", dryrun_dir)


def check_manifest(root: Path, findings: list[Finding]) -> None:
    manifest = root / "SEED_MANIFEST.sha256"
    if not manifest.exists():
        add(findings, "FAIL", "manifest", "Seed manifest is missing.", manifest)
        return
    listed = set()
    for raw in read_text(manifest).splitlines():
        parts = raw.split(maxsplit=1)
        if len(parts) == 2:
            listed.add(parts[1].replace("\\", "/"))

    important = [
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
        root / "docs" / "campaigns" / "001" / "bundle.md",
        root / "docs" / "campaigns" / "001" / "close_manifest.json",
        root / "docs" / "campaigns" / "001" / "rubric.json",
        root / "docs" / "campaigns" / "001" / "rubric_report.json",
        root / "docs" / "campaigns" / "001" / "rubric_results_input.json",
        root / "docs" / "campaigns" / "001" / "spec.json",
        root / "docs" / "campaigns" / "001" / "tx_hashes.json",
        root / "docs" / "campaigns" / "001" / "worker_output.md",
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
        root / "docs" / "campaigns" / "003" / "source_packet.md",
        root / "docs" / "campaigns" / "003" / "spec.json",
        root / "docs" / "campaigns" / "003" / "tx_hashes.json",
        root / "docs" / "campaigns" / "003" / "worker_output.md",
        root / "docs" / "campaigns" / "004" / "bundle.md",
        root / "docs" / "campaigns" / "004" / "close_manifest.json",
        root / "docs" / "campaigns" / "004" / "model_preferences.json",
        root / "docs" / "campaigns" / "004" / "rubric.json",
        root / "docs" / "campaigns" / "004" / "rubric_report.json",
        root / "docs" / "campaigns" / "004" / "rubric_results_input.json",
        root / "docs" / "campaigns" / "004" / "source_packet.md",
        root / "docs" / "campaigns" / "004" / "spec.json",
        root / "docs" / "campaigns" / "004" / "tx_hashes.json",
        root / "docs" / "campaigns" / "004" / "worker_output.md",
        root / "docs" / "campaigns" / "005" / "bundle.md",
        root / "docs" / "campaigns" / "005" / "close_manifest.json",
        root / "docs" / "campaigns" / "005" / "model_preferences.json",
        root / "docs" / "campaigns" / "005" / "rubric.json",
        root / "docs" / "campaigns" / "005" / "rubric_report.json",
        root / "docs" / "campaigns" / "005" / "rubric_results_input.json",
        root / "docs" / "campaigns" / "005" / "source_packet.md",
        root / "docs" / "campaigns" / "005" / "spec.json",
        root / "docs" / "campaigns" / "005" / "tx_hashes.json",
        root / "docs" / "campaigns" / "005" / "worker_output.md",
        root / "docs" / "campaigns" / "006" / "bundle.md",
        root / "docs" / "campaigns" / "006" / "close_manifest.json",
        root / "docs" / "campaigns" / "006" / "model_preferences.json",
        root / "docs" / "campaigns" / "006" / "rubric.json",
        root / "docs" / "campaigns" / "006" / "rubric_report.json",
        root / "docs" / "campaigns" / "006" / "rubric_results_input.json",
        root / "docs" / "campaigns" / "006" / "source_packet.md",
        root / "docs" / "campaigns" / "006" / "spec.json",
        root / "docs" / "campaigns" / "006" / "tx_hashes.json",
        root / "docs" / "campaigns" / "006" / "worker_output.md",
        root / "docs" / "campaigns" / "007" / "bundle.md",
        root / "docs" / "campaigns" / "007" / "close_manifest.json",
        root / "docs" / "campaigns" / "007" / "model_preferences.json",
        root / "docs" / "campaigns" / "007" / "rubric.json",
        root / "docs" / "campaigns" / "007" / "rubric_report.json",
        root / "docs" / "campaigns" / "007" / "rubric_results_input.json",
        root / "docs" / "campaigns" / "007" / "source_packet.md",
        root / "docs" / "campaigns" / "007" / "spec.json",
        root / "docs" / "campaigns" / "007" / "tx_hashes.json",
        root / "docs" / "campaigns" / "007" / "worker_output.md",
        root / "docs" / "dryrun" / "v14_dryrun_001.md",
        root / "docs" / "dryrun" / "v14_dryrun_002.md",
        root / "docs" / "dryrun" / "v15_dryrun_003.md",
        root / "docs" / "deployment" / "v15_rotation_record.md",
        root / "docs" / "deployment" / "pilot_escrow_deployments.md",
        root / "docs" / "strategy" / "MODEL_HANDOFF_TOOLING_REPORT_20260423.md",
        root / "docs" / "strategy" / "RUBRIC_FIRST_RETROSPECTIVE_PILOT_20260423.md",
        root / "tools" / "compare_seed_sdk.py",
        root / "tools" / "validate_project_alignment.py",
        root / "tools" / "campaign_scripts" / "draft_campaign_uid.js",
        root / "tools" / "campaign_scripts" / "fund_campaign.js",
        root / "tools" / "campaign_scripts" / "hash_close_payload.js",
        root / "tools" / "campaign_scripts" / "close_campaign.js",
        root / "tools" / "registry" / "README.md",
        root / "tools" / "registry" / "register_lane_eoa.js",
        root / "tools" / "setup" / "README.md",
        root / "tools" / "pilot_readiness_lint.py",
        root / "tools" / "oracle_scripts" / "sign_pilot_payload.js",
        root / "core" / "rubric_evaluator.py",
    ]
    for path in important:
        if path.exists() and rel(root, path) not in listed:
            add(
                findings,
                "WARN",
                "manifest",
                "Post-seed artifact is not covered by SEED_MANIFEST.sha256.",
                path,
                "Regenerate a post-DR002 manifest or add a supplemental manifest before forwarding as a sealed bundle.",
            )


def check_rotation(root: Path, findings: list[Finding]) -> None:
    record = root / "docs" / "deployment" / "v15_rotation_record.md"
    plan = root / "docs" / "deployment" / "v15_rotation_plan.md"
    if record.exists():
        add(findings, "PASS", "rotation", "v1.5 Oracle A rotation record exists.", record)
        if plan.exists():
            add(findings, "INFO", "rotation", "Legacy v15 plan path retained as a compatibility pointer.", plan)
    else:
        add(
            findings,
            "WARN",
            "rotation",
            "v1.5 Oracle A rotation record is absent.",
            record,
            "Record the executed v1.5 address, fresh Oracle A key, source hash, and DR003 tx before treating the seed as current-state handoff.",
        )


def check_signer_tooling(root: Path, findings: list[Finding]) -> None:
    signer = root / "tools" / "oracle_scripts" / "sign_pilot_payload.js"
    if signer.exists():
        add(findings, "PASS", "oracle-tooling", "Generic payload signer is present in the shared seed.", signer)
    else:
        add(
            findings,
            "WARN",
            "oracle-tooling",
            "Generic payload signer is missing from the shared seed.",
            signer,
            "Add a parameterized sign_pilot_payload.js before the first external campaign.",
        )

    campaign_scripts = [
        root / "tools" / "campaign_scripts" / "draft_campaign_uid.js",
        root / "tools" / "campaign_scripts" / "fund_campaign.js",
        root / "tools" / "campaign_scripts" / "hash_close_payload.js",
        root / "tools" / "campaign_scripts" / "close_campaign.js",
    ]
    missing = [script.name for script in campaign_scripts if not script.exists()]
    if missing:
        add(
            findings,
            "WARN",
            "oracle-tooling",
            "Canonical campaign scripts are missing: " + ", ".join(missing),
            root / "tools" / "campaign_scripts",
            "Keep funding, payload-hash, and close flows in the shared root toolchain.",
        )
    else:
        add(findings, "PASS", "oracle-tooling", "Canonical campaign scripts are present in the shared seed.", root / "tools" / "campaign_scripts")

    legacy_scripts = [
        root / "tools" / "oracle_scripts" / "generateOracleASig.js",
        root / "tools" / "oracle_scripts" / "generateOracleBSig.js",
        root / "tools" / "oracle_scripts" / "generateOracleCSig.js",
        root / "tools" / "oracle_scripts" / "dryrun_close.js",
        root / "tools" / "campaign_scripts" / "draft_sip518_bounty.js",
        root / "tools" / "campaign_scripts" / "fund_sip518.js",
    ]
    for script in legacy_scripts:
        if script.exists():
            add(
                findings,
                "WARN",
                "oracle-tooling",
                f"{script.name} is still present as a legacy one-off script.",
                script,
                "Remove one-off scripts from the live toolchain once the generic replacements are in place.",
            )


def check_pilot_source(root: Path, model_root: Path | None, findings: list[Finding]) -> None:
    candidates = [
        root / "solidity" / "contracts" / "PilotEscrow.sol",
        root / "solidity" / "PilotEscrow.sol",
    ]
    if any(path.exists() for path in candidates):
        add(findings, "PASS", "source", "PilotEscrow source is present in the shared seed.")
        return

    found_elsewhere = []
    if model_root and model_root.exists():
        found_elsewhere = sorted(model_root.glob("*/PilotEscrow.sol"))
    action = "Copy the exact v1.4/v1.5 source and source hash into the shared seed before asking other models to review deployment posture."
    if found_elsewhere:
        add(
            findings,
            "WARN",
            "source",
            "PilotEscrow source is outside the shared seed: " + ", ".join(str(path) for path in found_elsewhere),
            root / "solidity",
            action,
        )
    else:
        add(findings, "WARN", "source", "PilotEscrow source is not present in the compared trees.", root / "solidity", action)


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    for line_no, raw in enumerate(read_text(path).splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_no}: {exc}") from exc
    return rows


def is_explicitly_synthetic_attack_c_row(row: dict) -> bool:
    return (
        row.get("synthetic") is True
        or row.get("provenance_tier") == "synthetic"
        or row.get("attack_c_use") == "synthetic_fixture_only"
    )


def is_blocked_attack_c_row(row: dict) -> bool:
    return row.get("attack_c_use") == "blocked_until_provenance_or_reference_upgrade"


def check_attack_c_corpus(root: Path, findings: list[Finding]) -> None:
    corpus = root / "attack_runs" / "attack_c" / "grok_synthetic_fixture_20260422.jsonl"
    rubric_first = root / "docs" / "strategy" / "RUBRIC_FIRST_RETROSPECTIVE_PILOT_20260423.md"
    if not corpus.exists():
        add(findings, "WARN", "corpus", "Attack C synthetic fixture is missing.", corpus)
        return
    rows = load_jsonl(corpus)
    synthetic_rows = [row for row in rows if is_explicitly_synthetic_attack_c_row(row)]
    blocked_rows = [
        row for row in rows if not is_explicitly_synthetic_attack_c_row(row) and is_blocked_attack_c_row(row)
    ]
    active_rows = [
        row
        for row in rows
        if not is_explicitly_synthetic_attack_c_row(row) and not is_blocked_attack_c_row(row)
    ]
    verified = sum(1 for row in active_rows if row.get("provenance_tier") == "verified_url")
    missing_ref = sum(1 for row in active_rows if not str(row.get("reference_answer", "")).strip())
    long_rows = sum(1 for row in rows if row.get("length_bucket") == "long")
    dao_rows = sum(1 for row in rows if row.get("domain") == "dao-governance")
    exemplar_dir = root / "attack_runs" / "attack_c" / "claude_exemplars"
    exemplar_long_rows = 0
    if exemplar_dir.exists():
        for path in sorted(exemplar_dir.glob("*.jsonl")):
            exemplar_long_rows += sum(
                1 for row in load_jsonl(path) if row.get("length_bucket") == "long"
            )

    if synthetic_rows:
        add(
            findings,
            "INFO",
            "corpus",
            f"Attack C corpus has {len(synthetic_rows)}/{len(rows)} rows explicitly tagged as synthetic; verified_url and reference_answer readiness checks skip those rows.",
            corpus,
        )
    if blocked_rows:
        add(
            findings,
            "INFO",
            "corpus",
            f"Attack C corpus has {len(blocked_rows)} historical row(s) explicitly blocked until provenance/reference upgrades; readiness checks skip those rows for now.",
            corpus,
            "Upgrade or replace the blocked rows before using them as scored evaluation evidence.",
        )

    if active_rows and verified == 0:
        add(findings, "WARN", "corpus", f"Attack C corpus has {len(active_rows)} active rows but zero verified_url rows.", corpus)
    if active_rows and missing_ref:
        severity = "INFO" if rubric_first.exists() else "WARN"
        add(
            findings,
            severity,
            "corpus",
            f"Attack C corpus has {missing_ref}/{len(active_rows)} active rows without reference_answer.",
            corpus,
            "Rubric-first settlement makes this acceptable for the first campaign, but it still blocks headline V5.1 semantic scoring on this corpus.",
        )
    if not active_rows:
        add(
            findings,
            "INFO",
            "corpus",
            "Attack C corpus has no active readiness-scored rows after excluding explicitly synthetic and explicitly blocked entries.",
            corpus,
        )
    if long_rows + exemplar_long_rows == 0:
        add(findings, "WARN", "corpus", "Attack C materials have no long-bucket rows.", corpus)
    elif long_rows == 0 and exemplar_long_rows > 0:
        add(
            findings,
            "INFO",
            "corpus",
            f"Grok corpus has no long-bucket rows, but {exemplar_long_rows} long-bucket exemplar row(s) exist under attack_c/claude_exemplars.",
            exemplar_dir,
        )
    if dao_rows < 10:
        add(findings, "WARN", "corpus", f"Attack C corpus has only {dao_rows} dao-governance rows.", corpus)


def check_campaign_packaging(root: Path, findings: list[Finding]) -> None:
    campaign_dir = root / "docs" / "campaigns" / "001"
    required = [
        campaign_dir / "spec.json",
        campaign_dir / "rubric.json",
        campaign_dir / "worker_output.md",
        campaign_dir / "rubric_results_input.json",
        campaign_dir / "rubric_report.json",
        campaign_dir / "bundle.md",
        campaign_dir / "tx_hashes.json",
    ]
    missing = [path.name for path in required if not path.exists()]
    if missing:
        add(
            findings,
            "WARN",
            "campaign-packaging",
            "Campaign 001 does not fully match the numbered campaign standard: " + ", ".join(missing),
            campaign_dir,
            "Normalize the campaign into docs/campaigns/001/ before using it as the Campaign 002 packaging reference.",
        )
    else:
        add(findings, "PASS", "campaign-packaging", "Campaign 001 matches the numbered campaign packaging standard.", campaign_dir)

    campaign2_dir = root / "docs" / "campaigns" / "002"
    campaign2_required = [
        campaign2_dir / "spec.json",
        campaign2_dir / "rubric.json",
        campaign2_dir / "worker_output.md",
        campaign2_dir / "rubric_results_input.json",
        campaign2_dir / "rubric_report.json",
        campaign2_dir / "bundle.md",
        campaign2_dir / "tx_hashes.json",
        campaign2_dir / "model_preferences.json",
    ]
    campaign2_missing = [path.name for path in campaign2_required if not path.exists()]
    if campaign2_missing:
        add(
            findings,
            "WARN",
            "campaign-packaging",
            "Campaign 002 is missing expected files: " + ", ".join(campaign2_missing),
            campaign2_dir,
            "Keep Campaign 002 in the numbered campaign layout now that the target, worker lane, and settlement record are locked.",
        )
    else:
        add(findings, "PASS", "campaign-packaging", "Campaign 002 matches the numbered campaign packaging standard.", campaign2_dir)

    campaign3_dir = root / "docs" / "campaigns" / "003"
    campaign3_required = [
        campaign3_dir / "spec.json",
        campaign3_dir / "rubric.json",
        campaign3_dir / "worker_output.md",
        campaign3_dir / "rubric_results_input.json",
        campaign3_dir / "rubric_report.json",
        campaign3_dir / "bundle.md",
        campaign3_dir / "tx_hashes.json",
        campaign3_dir / "model_preferences.json",
    ]
    campaign3_missing = [path.name for path in campaign3_required if not path.exists()]
    if campaign3_missing:
        add(
            findings,
            "WARN",
            "campaign-packaging",
            "Campaign 003 is missing expected files: " + ", ".join(campaign3_missing),
            campaign3_dir,
            "Keep the active campaign in the numbered packaging layout before worker provisioning and funding move it forward.",
        )
    else:
        add(findings, "PASS", "campaign-packaging", "Campaign 003 matches the numbered campaign packaging standard for an active scaffold.", campaign3_dir)

    campaign4_dir = root / "docs" / "campaigns" / "004"
    campaign4_required = [
        campaign4_dir / "spec.json",
        campaign4_dir / "rubric.json",
        campaign4_dir / "worker_output.md",
        campaign4_dir / "rubric_results_input.json",
        campaign4_dir / "rubric_report.json",
        campaign4_dir / "bundle.md",
        campaign4_dir / "tx_hashes.json",
        campaign4_dir / "model_preferences.json",
    ]
    campaign4_missing = [path.name for path in campaign4_required if not path.exists()]
    if campaign4_missing:
        add(
            findings,
            "WARN",
            "campaign-packaging",
            "Campaign 004 is missing expected files: " + ", ".join(campaign4_missing),
            campaign4_dir,
            "Keep the active campaign in the numbered packaging layout before worker provisioning and funding move it forward.",
        )
    else:
        add(findings, "PASS", "campaign-packaging", "Campaign 004 matches the numbered campaign packaging standard for an active scaffold.", campaign4_dir)

    campaign5_dir = root / "docs" / "campaigns" / "005"
    campaign5_required = [
        campaign5_dir / "spec.json",
        campaign5_dir / "rubric.json",
        campaign5_dir / "worker_output.md",
        campaign5_dir / "rubric_results_input.json",
        campaign5_dir / "rubric_report.json",
        campaign5_dir / "bundle.md",
        campaign5_dir / "tx_hashes.json",
        campaign5_dir / "model_preferences.json",
    ]
    campaign5_missing = [path.name for path in campaign5_required if not path.exists()]
    if campaign5_missing:
        add(
            findings,
            "WARN",
            "campaign-packaging",
            "Campaign 005 is missing expected files: " + ", ".join(campaign5_missing),
            campaign5_dir,
            "Keep the active campaign in the numbered packaging layout before funding and worker drafting move it forward.",
        )
    else:
        add(findings, "PASS", "campaign-packaging", "Campaign 005 matches the numbered campaign packaging standard for an active scaffold.", campaign5_dir)

    campaign6_dir = root / "docs" / "campaigns" / "006"
    campaign6_required = [
        campaign6_dir / "spec.json",
        campaign6_dir / "rubric.json",
        campaign6_dir / "worker_output.md",
        campaign6_dir / "rubric_results_input.json",
        campaign6_dir / "rubric_report.json",
        campaign6_dir / "bundle.md",
        campaign6_dir / "tx_hashes.json",
        campaign6_dir / "model_preferences.json",
    ]
    campaign6_missing = [path.name for path in campaign6_required if not path.exists()]
    if campaign6_missing:
        add(
            findings,
            "WARN",
            "campaign-packaging",
            "Campaign 006 is missing expected files: " + ", ".join(campaign6_missing),
            campaign6_dir,
            "Keep the active campaign in the numbered packaging layout before funding and worker drafting move it forward.",
        )
    else:
        add(findings, "PASS", "campaign-packaging", "Campaign 006 matches the numbered campaign packaging standard for an active scaffold.", campaign6_dir)

    campaign7_dir = root / "docs" / "campaigns" / "007"
    campaign7_required = [
        campaign7_dir / "spec.json",
        campaign7_dir / "rubric.json",
        campaign7_dir / "worker_output.md",
        campaign7_dir / "rubric_results_input.json",
        campaign7_dir / "rubric_report.json",
        campaign7_dir / "bundle.md",
        campaign7_dir / "tx_hashes.json",
        campaign7_dir / "model_preferences.json",
    ]
    campaign7_missing = [path.name for path in campaign7_required if not path.exists()]
    if campaign7_missing:
        add(
            findings,
            "WARN",
            "campaign-packaging",
            "Campaign 007 is missing expected files: " + ", ".join(campaign7_missing),
            campaign7_dir,
            "Keep the active campaign in the numbered packaging layout before funding and worker drafting move it forward.",
        )
    else:
        add(findings, "PASS", "campaign-packaging", "Campaign 007 matches the numbered campaign packaging standard for an active scaffold.", campaign7_dir)


def check_exemplars(root: Path, findings: list[Finding]) -> None:
    matches = []
    ignored = {
        "MODEL_HANDOFF_TOOLING_REPORT_20260423.md",
        "pilot_readiness_lint.py",
    }
    ignored_parts = {"node_modules", "archive", "__pycache__"}
    for path in root.rglob("*"):
        if ignored_parts.intersection(path.parts):
            continue
        if path.name in ignored:
            continue
        if not path.is_file() or path.suffix.lower() not in {".md", ".json", ".jsonl", ".txt"}:
            continue
        try:
            text = read_text(path)
        except UnicodeDecodeError:
            continue
        if "FictionalProtocolA" in text:
            matches.append(path)
    if matches:
        add(findings, "PASS", "exemplars", f"Found {len(matches)} fictional DAO exemplar artifact(s).")
    else:
        add(
            findings,
            "WARN",
            "exemplars",
            "Claude's reported v1-v4 FictionalProtocolA exemplars are not persisted in the shared seed.",
            root / "docs" / "strategy",
            "Save the four exemplar rows before GPT shape review, or the next model will be reviewing conversation text rather than repo artifacts.",
        )


def check_sdk_gap(root: Path, sdk_root: Path | None, findings: list[Finding]) -> None:
    if not sdk_root or not sdk_root.exists():
        return
    useful_sdk_only = [
        "attacks/attack_c_eval.py",
        "attacks/v51_scoring.py",
        "tools/tabulate_grok_attack_c_corpus.py",
        "oracle/oracle_signer.py",
        "solidity/contracts/VENOMRegistry_V5.sol",
    ]
    missing = [rel_path for rel_path in useful_sdk_only if (sdk_root / rel_path).exists() and not (root / rel_path).exists()]
    if missing:
        add(
            findings,
            "INFO",
            "seed-vs-sdk",
            "Working SDK contains useful executable files not present in the shared seed: " + ", ".join(missing),
            sdk_root,
            "Keep the seed compact, but point models to attacker_sdk when they need executable harness context.",
        )


def check_integrator(root: Path, findings: list[Finding]) -> None:
    campaign_bundle = root / "docs" / "campaigns" / "001" / "bundle.md"
    if campaign_bundle.exists():
        add(
            findings,
            "PASS",
            "campaign-bundle",
            "Campaign 001 funded retrospective bundle is recorded in the shared seed.",
            campaign_bundle,
        )

    retrospective = root / "docs" / "strategy" / "RUBRIC_FIRST_RETROSPECTIVE_PILOT_20260423.md"
    if retrospective.exists():
        add(
            findings,
            "PASS",
            "campaign-direction",
            "Retrospective-artifact-first campaign direction is recorded in the shared seed.",
            retrospective,
        )
        return

    phase = root / "docs" / "strategy" / "PHASE3A_CLOSEOUT_PHASE3B_OPENING.md"
    if phase.exists() and "First integrator:                          NOT NAMED" in read_text(phase):
        add(
            findings,
            "WARN",
            "integrator",
            "First integrator is still marked NOT NAMED in the seed.",
            phase,
            "Operator should nominate the target or explicitly approve a shortlist workflow before bounty drafting.",
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--model-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--sdk-root", type=Path, default=Path(__file__).resolve().parents[2] / "attacker_sdk")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--strict", action="store_true", help="Exit non-zero on WARN as well as FAIL.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.seed_root.resolve()
    findings: list[Finding] = []

    check_dryruns(root, findings)
    check_manifest(root, findings)
    check_campaign_packaging(root, findings)
    check_rotation(root, findings)
    check_signer_tooling(root, findings)
    check_pilot_source(root, args.model_root.resolve() if args.model_root else None, findings)
    check_attack_c_corpus(root, findings)
    check_exemplars(root, findings)
    check_sdk_gap(root, args.sdk_root.resolve() if args.sdk_root else None, findings)
    check_integrator(root, findings)

    if args.json:
        print(json.dumps([finding.__dict__ for finding in findings], indent=2, sort_keys=True))
    else:
        for finding in findings:
            location = f" [{finding.path}]" if finding.path else ""
            print(f"{finding.severity}: {finding.topic}: {finding.message}{location}")
            if finding.action:
                print(f"  action: {finding.action}")

    has_fail = any(f.severity == "FAIL" for f in findings)
    has_warn = any(f.severity == "WARN" for f in findings)
    return 1 if has_fail or (args.strict and has_warn) else 0


if __name__ == "__main__":
    raise SystemExit(main())
