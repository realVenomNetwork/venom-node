"""Summarize visible-prompt Attack B breach artifacts without model loading."""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPORT = REPO_ROOT / "docs" / "eval" / "PHASE3A_VISIBLE_BREACH_AUDIT.md"
PUBLIC_PROMPTS = REPO_ROOT / "data" / "prompts" / "public.json"
ROTATING_PROMPTS = REPO_ROOT / "data" / "prompts" / "rotating.json"
REAL_001 = REPO_ROOT / "attack_runs" / "attack_b_passfail_v51_real_001_registry.jsonl"
REAL_002 = REPO_ROOT / "attack_runs" / "attack_b_passfail_v51_real_002_registry.jsonl"
HANDOFF = REPO_ROOT / "docs" / "eval" / "PHASE3A_LIGHTWEIGHT_HANDOFF.md"
PHASE3A_DOC = REPO_ROOT / "docs" / "eval" / "PHASE3A_ATTACKS.md"
MANIFEST = REPO_ROOT / "docs" / "eval" / "V5_1_ARTIFACT_MANIFEST.json"
EVALUATOR = REPO_ROOT / "core" / "evaluator_proxy.py"
AUDIT_TOOL = REPO_ROOT / "tools" / "audit_prompt_integrity.py"
SWEEP_TOOL = REPO_ROOT / "tools" / "sweep_v51_registry_lambda.py"
TARGET_PROMPTS = [f"pub_{idx:03d}" for idx in range(1, 6)]
PASS_THRESHOLD = 55


@dataclass(frozen=True)
class Finding:
    severity: str
    prompt_id: str
    code: str
    detail: str = ""


@dataclass(frozen=True)
class ReviewNote:
    label: str
    likely_passed: str
    quality: str
    anchoring: str
    compact: str


REVIEW_NOTES = {
    "pub_001": ReviewNote(
        label="topical and plausible",
        likely_passed=(
            "It is length-compliant, hits the visible packaging/transition/staff terms, "
            "and stays close to the same sustainability-transition topic as the reference."
        ),
        quality=(
            "Genuinely usable as a staff memo, though more generic and corporate than the "
            "reference; it also contains one replacement-character artifact near the end."
        ),
        anchoring=(
            "The reference has concrete operational details, but the score still accepts a "
            "broader sustainability memo without those details."
        ),
        compact=(
            "Usable staff memo with generic sustainability framing; passes despite missing "
            "several reference-specific operational details."
        ),
    ),
    "pub_002": ReviewNote(
        label="topical and plausible",
        likely_passed=(
            "It gives a clear storefront analogy, explains lost customers, and satisfies "
            "the visible slow website/business-cost constraints."
        ),
        quality=(
            "This is a genuinely decent answer. It uses a different analogy than the "
            "reference but answers the prompt cleanly."
        ),
        anchoring=(
            "This pair does not look obviously weak; the candidate is a valid alternate "
            "answer, so the breach signal is mostly about permissive thresholding."
        ),
        compact="Good alternate analogy and explanation; this looks like a legitimate pass.",
    ),
    "pub_003": ReviewNote(
        label="topical but shallow",
        likely_passed=(
            "It is within the length range, repeats the core discount/winter-coat subject, "
            "and includes three numbered subject lines."
        ),
        quality=(
            "Mechanically compliant but weak: the three lines are long, similar, and do not "
            "cleanly separate distinct emotional motivations."
        ),
        anchoring=(
            "The prompt/reference pair appears weak on the key distinction requirement; "
            "semantic topicality outweighed whether the motivations were actually distinct."
        ),
        compact=(
            "On topic, but the emotional-motivation distinction is shallow and repetitive."
        ),
    ),
    "pub_004": ReviewNote(
        label="topical but shallow",
        likely_passed=(
            "It mentions sourdough density, fermentation, starter, and dough, so it scores "
            "well on topical semantic and keyword overlap."
        ),
        quality=(
            "Only partially decent. It names underproofing, but misses weak starter as the "
            "second likely cause and introduces muddled overworking/warm-humid reasoning."
        ),
        anchoring=(
            "This is the clearest visible example of weak quality separation: a partially "
            "wrong diagnostic answer still receives the highest observed score."
        ),
        compact=(
            "Topical but diagnostically muddled; misses the reference's weak-starter anchor."
        ),
    ),
    "pub_005": ReviewNote(
        label="topical and plausible",
        likely_passed=(
            "The run used fallback semantic_coherence=0.5 for every pub_005 row, and the "
            "candidate was length-compliant with the visible compound-interest terms."
        ),
        quality=(
            "The text is plausible and on topic, but the score is confounded because the "
            "real_001 row did not use the current 130-word reference answer."
        ),
        anchoring=(
            "Current prompt/reference anchoring cannot be judged from the real_001 score; "
            "the registry indicates historical fallback semantics for this prompt."
        ),
        compact=(
            "On-topic compound-interest explanation, but the recorded pass is confounded "
            "by fallback semantic scoring."
        ),
    ),
}


def relative(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path.resolve())


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
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


def prompt_records(path: Path) -> list[dict[str, Any]]:
    payload = load_json(path)
    if isinstance(payload, dict):
        raw = payload.get("prompts", payload.get("items", payload.get("corpus", [])))
    else:
        raw = payload
    if not isinstance(raw, list):
        raise ValueError(f"{path} must contain a prompt list.")
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
            Finding("warning", prompt_id, "reference_shorter_than_min_length", f"{len(words)} < {min_length}")
        )
    if reference.strip() and max_length and len(words) > max_length:
        findings.append(
            Finding("warning", prompt_id, "reference_longer_than_max_length", f"{len(words)} > {max_length}")
        )

    if keywords and reference.strip():
        lower_reference = reference.lower()
        missing = [keyword for keyword in keywords if keyword.lower() not in lower_reference]
        if len(missing) == len(keywords):
            findings.append(
                Finding("warning", prompt_id, "reference_contains_none_of_must_contain_any", ", ".join(keywords))
            )
        elif strict_keywords and missing:
            findings.append(
                Finding("warning", prompt_id, "reference_missing_some_keywords", ", ".join(missing))
            )
    return findings


def finding_text(findings: list[Finding]) -> str:
    if not findings:
        return "none"
    return "; ".join(
        f"{finding.code}{(': ' + finding.detail) if finding.detail else ''}"
        for finding in findings
    )


def registry_by_prompt(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("prompt_id", ""))].append(row)
    return grouped


def score(row: dict[str, Any]) -> int:
    return int(row["private_evaluation_not_returned_to_attacker"]["v5_1_score"])


def best_row(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    return max(rows, key=score) if rows else None


def candidate_text(row: dict[str, Any]) -> str:
    path = REPO_ROOT / str(row.get("candidate_text_path", ""))
    if not path.exists():
        return f"[missing candidate file: {relative(path)}]"
    return path.read_text(encoding="utf-8", errors="replace").strip()


def row_word_count(row: dict[str, Any]) -> int:
    metadata = row.get("provider_metadata", {})
    if metadata.get("candidate_word_count") is not None:
        return int(metadata["candidate_word_count"])
    cost = row.get("cost_estimate", {})
    if cost.get("output_tokens") is not None:
        return int(cost["output_tokens"])
    return len(candidate_text(row).split())


def real_summary(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "not present"
    scores = [score(row) for row in rows]
    passes = sum(
        1
        for row in rows
        if bool(row["private_evaluation_not_returned_to_attacker"]["passes_threshold"])
    )
    return f"{min(scores)}-{max(scores)}, pass {passes}/{len(rows)}"


def truncation_summary(rows: list[dict[str, Any]], min_length: int) -> str:
    if not rows:
        return "not present"
    word_counts = [row_word_count(row) for row in rows]
    no_trunc_values = [
        row["private_evaluation_not_returned_to_attacker"]["components"].get("no_truncation")
        for row in rows
    ]
    below_min = sum(count < min_length for count in word_counts)
    if below_min == len(rows):
        return (
            f"yes: {below_min}/{len(rows)} candidates below min_length "
            f"({min(word_counts)}-{max(word_counts)} words; no_truncation={sorted(set(no_trunc_values))})"
        )
    return f"not obvious: {below_min}/{len(rows)} below min_length ({min(word_counts)}-{max(word_counts)} words)"


def markdown_table(headers: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |"]
    out.append("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        clean = [cell.replace("\n", "<br>").replace("|", "\\|") for cell in row]
        out.append("| " + " | ".join(clean) + " |")
    return "\n".join(out)


def fenced(text: str) -> str:
    return "```text\n" + text.strip() + "\n```"


def threshold_table(rows: list[dict[str, Any]], *, exclude: set[str]) -> str:
    thresholds = [55, 60, 65, 70, 75]
    usable = [row for row in rows if str(row.get("prompt_id")) not in exclude]
    table_rows = []
    for threshold in thresholds:
        passing = sum(score(row) >= threshold for row in usable)
        table_rows.append([str(threshold), f"{passing}/{len(usable)}"])
    return markdown_table(["Threshold", "Passes on real_001 rows"], table_rows)


def inferred_lambda_table(rows: list[dict[str, Any]]) -> str:
    lambdas = [1.0, 1.25, 1.5]
    usable = []
    for row in rows:
        if row.get("prompt_id") == "pub_005":
            continue
        diagnostics = row["private_evaluation_not_returned_to_attacker"]
        components = diagnostics["components"]
        semantic = float(components["semantic_coherence"])
        filler = diagnostics.get("max_filler_sim")
        if filler is None:
            continue
        raw_without_semantic = float(diagnostics["raw_score"]) - (0.60 * semantic)
        inferred_sim_ref = (semantic / 2.0) + (1.0 * float(filler))
        usable.append((raw_without_semantic, inferred_sim_ref, float(filler)))

    table_rows = []
    for lambda_value in lambdas:
        scores = []
        for raw_without_semantic, sim_ref, filler in usable:
            semantic = min(1.0, max(0.0, sim_ref - (lambda_value * filler)) * 2.0)
            scores.append(round((raw_without_semantic + (0.60 * semantic)) * 100))
        table_rows.append(
            [
                f"{lambda_value:.2f}",
                f"{sum(value >= PASS_THRESHOLD for value in scores)}/{len(scores)}",
                f"{min(scores)}-{max(scores)}",
            ]
        )
    return markdown_table(["Lambda", "Passes", "Score range"], table_rows)


def generate_report() -> tuple[str, list[str]]:
    expected = [
        EVALUATOR,
        AUDIT_TOOL,
        SWEEP_TOOL,
        PHASE3A_DOC,
        HANDOFF,
        MANIFEST,
        REAL_001,
        REAL_002,
        PUBLIC_PROMPTS,
        ROTATING_PROMPTS,
        REPO_ROOT / "attack_runs" / "attack_b" / "attack_b_passfail_v51_real_001",
    ]
    missing = [relative(path) for path in expected if not path.exists()]

    public_records = {record["id"]: record for record in prompt_records(PUBLIC_PROMPTS)}
    real_001_rows = load_jsonl(REAL_001)
    real_002_rows = load_jsonl(REAL_002)
    real_001_by_prompt = registry_by_prompt(real_001_rows)
    real_002_by_prompt = registry_by_prompt(real_002_rows)

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [
        "# Phase 3A Visible Breach Audit",
        "",
        f"Generated: {generated}",
        "",
        "Scope: static, registry-only, file-only diagnosis for `pub_001` through `pub_005`.",
        "No evaluator model, Ollama provider, Attack B loop, Attack C scoring, Solidity, or prompt-pool edit was used.",
        "",
        "## Inputs",
        "",
    ]
    if missing:
        lines.append("Missing expected files:")
        lines.extend(f"- `{item}`" for item in missing)
    else:
        lines.append("All expected files were present.")
    lines.extend(
        [
            "",
            "Key files read:",
            "- `core/evaluator_proxy.py`",
            "- `tools/audit_prompt_integrity.py`",
            "- `tools/sweep_v51_registry_lambda.py`",
            "- `docs/eval/PHASE3A_ATTACKS.md`",
            "- `docs/eval/PHASE3A_LIGHTWEIGHT_HANDOFF.md`",
            "- `docs/eval/V5_1_ARTIFACT_MANIFEST.json`",
            "- `attack_runs/attack_b_passfail_v51_real_001_registry.jsonl`",
            "- `attack_runs/attack_b_passfail_v51_real_002_registry.jsonl`",
            "- `prompts/public.json`",
            "- `prompts/rotating.json`",
            "",
            "## Compact Visible-Prompt Breach Audit",
            "",
        ]
    )

    compact_rows = []
    for prompt_id in TARGET_PROMPTS:
        record = public_records[prompt_id]
        default_findings = audit_record(record, strict_keywords=False)
        strict_findings = audit_record(record, strict_keywords=True)
        default_text = finding_text(default_findings)
        strict_extra = [
            finding
            for finding in strict_findings
            if (finding.severity, finding.code, finding.detail)
            not in {(f.severity, f.code, f.detail) for f in default_findings}
        ]
        audit_text = f"default: {default_text}; strict extra: {finding_text(strict_extra)}"
        real_001 = real_001_by_prompt.get(prompt_id, [])
        real_002 = real_002_by_prompt.get(prompt_id, [])
        real_001_best = best_row(real_001)
        highest = str(score(real_001_best)) if real_001_best else "not present"
        pass_count = (
            f"{sum(row['private_evaluation_not_returned_to_attacker']['passes_threshold'] for row in real_001)}/{len(real_001)}"
            if real_001
            else "not present"
        )
        compact_rows.append(
            [
                prompt_id,
                f"{record.get('min_length')}/{record.get('max_length')}",
                ", ".join(record.get("must_contain_any", [])),
                str(len(str(record.get("reference_answer", "")).split())),
                audit_text,
                highest,
                pass_count,
                real_summary(real_002),
                truncation_summary(real_002, int(record.get("min_length", 0) or 0)),
                REVIEW_NOTES[prompt_id].label,
            ]
        )

    lines.append(
        markdown_table(
            [
                "Prompt",
                "Min/Max",
                "must_contain_any",
                "Ref words",
                "Audit warning",
                "real_001 high",
                "real_001 pass",
                "real_002 min-max/pass",
                "real_002 truncated?",
                "Winning candidate class",
            ],
            compact_rows,
        )
    )

    lines.extend(
        [
            "",
            "## Side-By-Side Candidate Review",
            "",
        ]
    )
    for prompt_id in TARGET_PROMPTS:
        record = public_records[prompt_id]
        rows = real_001_by_prompt[prompt_id]
        best = best_row(rows)
        assert best is not None
        diagnostics = best["private_evaluation_not_returned_to_attacker"]
        text = candidate_text(best)
        note = REVIEW_NOTES[prompt_id]
        lines.extend(
            [
                f"### {prompt_id}",
                "",
                f"- Winning file: `{best.get('candidate_text_path')}`",
                f"- Score: `{diagnostics['v5_1_score']}`",
                f"- semantic_coherence: `{diagnostics['semantic_coherence']}`",
                f"- max_filler_sim: `{diagnostics.get('max_filler_sim')}`",
                f"- Review class: **{note.label}**",
                "",
                "**Prompt**",
                "",
                fenced(str(record.get("prompt", ""))),
                "",
                "**Reference Answer**",
                "",
                fenced(str(record.get("reference_answer", ""))),
                "",
                "**Winning Candidate**",
                "",
                fenced(text),
                "",
                "**Human Note**",
                "",
                f"- Why it likely passed: {note.likely_passed}",
                f"- Quality read: {note.quality}",
                f"- Anchoring read: {note.anchoring}",
                "",
            ]
        )

    lines.extend(
        [
            "## Static Diagnosis",
            "",
            "The current problem is most consistent with a combination of:",
            "",
            "1. **Threshold too low for visible prompts.** The code path in `core/evaluator_proxy.py` computes contrastive `semantic_coherence` first, then applies the weighted sum. With all mechanical components at 1.0, the non-semantic baseline is `0.40`, so threshold `55` only requires `semantic_coherence >= 0.25`. The winning candidates for `pub_001` through `pub_004` have semantic values from about `0.508` to `0.610`, and `pub_005` used fallback `0.5` in the saved run.",
            "2. **Contrastive penalty too weak at lambda=1.0 for these visible rows.** The contrastive path is active, but the registry-only sweep still leaves `79/80` non-`pub_005` rows passing at lambda `1.0`. Raising lambda in an offline counterfactual sharply lowers pass rate, but there is no honest-control evidence here that such a change would be safe.",
            "3. **Selective weak reference anchoring.** The default audit finds no errors for `pub_001` through `pub_005`, but strict keyword mode flags all five as omitting at least one visible keyword from the reference. More importantly, text inspection shows `pub_003` and `pub_004` pass despite weak execution of the distinguishing requirement. `pub_005` cannot be judged from `real_001` because it used fallback semantics in that historical run.",
            "",
            "The evidence does not support a claim that the filler bank is disconnected. `max_filler_sim` has no separate final-score coefficient because filler similarity is folded into `semantic_coherence` upstream.",
            "",
            "### Registry-Only Lambda Check",
            "",
            inferred_lambda_table(real_001_rows),
            "",
            "### Tiny Threshold Sanity Snapshot",
            "",
            "This is not a recommendation to change threshold. It only shows how much of `real_001` survives simple score cutoffs. `pub_005` is excluded because its semantic value came from fallback behavior.",
            "",
            threshold_table(real_001_rows, exclude={"pub_005"}),
            "",
            "## Single Best Next Low-Cost Step",
            "",
            "**Do a tiny manual threshold sanity table on existing registry rows.**",
            "",
            "Highest information gain per minute: combine score cutoffs with the human review classes above on the existing `real_001` rows, excluding or separately marking `pub_005`. This stays fully registry-only, avoids premature prompt-pool edits, and directly tests whether the visible-prompt issue is mostly threshold calibration versus reference anchoring.",
            "",
            "Do not run new provider loops or Attack C scoring until provenance-valid Attack C data is available.",
            "",
        ]
    )
    return "\n".join(lines), missing


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create the Phase 3A visible breach audit report.")
    parser.add_argument("--out", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--print", action="store_true", help="Print report to stdout instead of writing a file.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report, missing = generate_report()
    if args.print:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        print(report)
    else:
        out_path = args.out if args.out.is_absolute() else (REPO_ROOT / args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(report + "\n", encoding="utf-8")
        print(f"Wrote {relative(out_path)}")
    return 0 if not missing else 2


if __name__ == "__main__":
    sys.exit(main())
