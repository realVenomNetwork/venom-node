"""Attack B: adaptive black-box scorer optimization harness.

This is a scaffold for adversarial scorer evaluation, not a result generator.
The default provider is deterministic mock generation so the harness can be
validated without API credentials.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / 'eval_engine'))

from attacks.v51_scoring import (
    FROZEN_V51_FILLER_BANK,
    build_v51_scorer,
    load_prompt_specs,
    resolve_repo_path,
    score_output,
    spec_public_payload,
    validate_visible_prompt_specs,
)


DEFAULT_MANIFEST = REPO_ROOT / "docs" / "eval" / "V5_1_ARTIFACT_MANIFEST.json"
DEFAULT_REGISTRY = REPO_ROOT / "attack_runs" / "attack_b_registry.jsonl"
DEFAULT_RUN_DIR = REPO_ROOT / "attack_runs" / "attack_b"
SYSTEM_PROMPT = REPO_ROOT / "attacks" / "data" / "prompts" / "attack_b_system.txt"
USER_TEMPLATE = REPO_ROOT / "attacks" / "data" / "prompts" / "attack_b_user_template.txt"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def preview_text(value: str, limit: int = 160) -> str:
    one_line = " ".join(value.split())
    if len(one_line) <= limit:
        return one_line
    return one_line[: max(0, limit - 1)].rstrip() + "..."


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


@dataclass(frozen=True)
class ProviderResult:
    candidate_text: str
    provider_metadata: dict[str, Any]


class CandidateProvider:
    name = "base"

    def generate(self, payload: dict[str, Any]) -> ProviderResult:
        raise NotImplementedError


class MockCandidateProvider(CandidateProvider):
    """Deterministic provider for validating logging and feedback plumbing."""

    name = "mock"

    def generate(self, payload: dict[str, Any]) -> ProviderResult:
        public_spec = payload["public_spec"]
        iteration = int(payload["iteration"])
        visible_prompt = public_spec.get("visible_prompt", "")
        keywords = list(public_spec.get("must_contain_any", []))
        target = max(
            int(public_spec.get("min_length", 40)),
            min(
                int(public_spec.get("max_length", 120)),
                round((int(public_spec.get("min_length", 40)) + int(public_spec.get("max_length", 120))) / 2),
            ),
        )

        topic = self._topic(visible_prompt, keywords)
        keyword_clause = self._keyword_clause(keywords)
        openings = [
            f"A practical answer about {topic} should stay concrete and useful.",
            f"The clearest way to handle {topic} is to name the tradeoff and then give a specific next step.",
            f"For {topic}, a strong response should connect the situation to what someone can actually do.",
        ]
        bodies = [
            f"It should avoid generic reassurance and instead explain what changes, why it matters, and where the limits are.",
            f"The answer works better when it includes a small example, a consequence, and a plain-language explanation.",
            f"It should keep the tone direct while still showing enough context for the reader to trust the reasoning.",
        ]
        closers = [
            f"{keyword_clause} The final version should feel specific enough to be checked, not just broadly agreeable.",
            f"{keyword_clause} That makes the response easier to evaluate against the prompt instead of against surface fluency.",
            f"{keyword_clause} The goal is a useful answer with visible substance and no hidden-prompt assumptions.",
        ]

        sentences = [
            openings[iteration % len(openings)],
            bodies[(iteration // len(openings)) % len(bodies)],
            closers[iteration % len(closers)],
        ]
        candidate = " ".join(sentences)
        candidate = self._pad(candidate, target, iteration)
        return ProviderResult(
            candidate_text=candidate,
            provider_metadata={
                "provider": self.name,
                "dry_run": True,
                "cost_estimate": {
                    "input_tokens": None,
                    "output_tokens": len(candidate.split()),
                    "estimated_usd": None,
                },
            },
        )

    def _topic(self, visible_prompt: str, keywords: list[str]) -> str:
        if keywords:
            return " ".join(keywords[:2])
        words = [
            token.strip(".,:;!?()[]{}\"'").lower()
            for token in visible_prompt.split()
            if len(token.strip(".,:;!?()[]{}\"'")) > 4
        ]
        return " ".join(words[:2]) if words else "the visible task"

    def _keyword_clause(self, keywords: list[str]) -> str:
        if not keywords:
            return "The answer should keep the visible constraints explicit."
        if len(keywords) == 1:
            return f"The answer should make {keywords[0]} visible without stuffing the term."
        return f"The answer should make {', '.join(keywords[:4])} visible without stuffing the terms."

    def _pad(self, text: str, target: int, iteration: int) -> str:
        expansions = [
            "A small concrete detail is usually more valuable than another abstract sentence.",
            "The wording should preserve ordinary language so the response does not become a template.",
            "If there is uncertainty, it should be attached to a real condition rather than used as filler.",
            "Each sentence should add a distinct piece of meaning before the answer ends.",
        ]
        parts = [text]
        idx = iteration
        while len(" ".join(parts).split()) < target:
            parts.insert(-1 if len(parts) > 1 else len(parts), expansions[idx % len(expansions)])
            idx += 1
            if len(parts) > 12:
                break
        return " ".join(parts)


class CommandCandidateProvider(CandidateProvider):
    """Provider adapter for a local command that reads JSON and returns a candidate."""

    name = "command"

    def __init__(self, command: str):
        if not command:
            raise ValueError("--provider-command is required when --provider command is used.")
        self.command = command

    def generate(self, payload: dict[str, Any]) -> ProviderResult:
        command = shlex.split(self.command, posix=os.name != "nt")
        completed = subprocess.run(
            command,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if completed.returncode != 0:
            raise RuntimeError(
                "Provider command failed "
                f"with exit code {completed.returncode}: {' '.join(command)}\n"
                f"STDERR:\n{completed.stderr.strip()}"
            )
        stdout = completed.stdout.strip()
        try:
            decoded = json.loads(stdout)
        except json.JSONDecodeError:
            decoded = {"candidate": stdout}
        candidate = decoded.get("candidate") or decoded.get("candidate_text")
        if not candidate:
            raise RuntimeError("Provider command must return text or JSON with candidate/candidate_text.")
        metadata = dict(decoded.get("metadata", {}))
        metadata.setdefault("provider", self.name)
        metadata.setdefault("cost_estimate", {"input_tokens": None, "output_tokens": None, "estimated_usd": None})
        return ProviderResult(candidate_text=str(candidate), provider_metadata=metadata)


def build_provider(args: argparse.Namespace) -> CandidateProvider:
    if args.dry_run:
        return MockCandidateProvider()
    if args.provider == "mock":
        return MockCandidateProvider()
    if args.provider == "command":
        return CommandCandidateProvider(args.provider_command)
    raise ValueError(f"Unsupported provider: {args.provider}")


def prior_feedback_incorporated(
    *,
    iteration: int,
    provider_name: str,
    provider_metadata: dict[str, Any],
) -> bool | None:
    if iteration <= 1:
        return False
    if "prior_feedback_incorporated" in provider_metadata:
        return bool(provider_metadata["prior_feedback_incorporated"])
    if "used_feedback" in provider_metadata:
        return bool(provider_metadata["used_feedback"])
    if provider_name == "mock":
        return False
    return None


def feedback_for_mode(mode: str, diagnostics: dict[str, Any]) -> dict[str, Any]:
    passed = bool(diagnostics["passes_threshold"])
    score = int(diagnostics["v5_1_score"])
    if mode == "raw_score":
        return {
            "mode": "raw_score",
            "black_box_label": "optimistic_black_box",
            "passed": passed,
            "score": score,
        }
    if mode == "pass_fail":
        return {
            "mode": "pass_fail",
            "black_box_label": "realistic_black_box",
            "passed": passed,
            "score": score if passed else None,
        }
    if mode == "gray_box":
        return {
            "mode": "gray_box",
            "black_box_label": "worst_case_gray_box",
            "passed": passed,
            "score": score,
            "components": diagnostics["components"],
            "max_filler_sim": diagnostics.get("max_filler_sim"),
        }
    raise ValueError(f"Unknown feedback mode: {mode}")


def update_observed_best(mode: str, best: dict[str, Any], feedback: dict[str, Any]) -> dict[str, Any]:
    if mode in {"raw_score", "gray_box"}:
        score = feedback.get("score")
        if best.get("score") is None or (score is not None and score > best["score"]):
            return {"score": score, "passed": feedback["passed"]}
        return best

    pass_count = int(best.get("pass_count", 0)) + (1 if feedback["passed"] else 0)
    best_passing_score = best.get("best_passing_score")
    if feedback.get("score") is not None:
        best_passing_score = max(best_passing_score or 0, int(feedback["score"]))
    return {
        "pass_count": pass_count,
        "best_passing_score": best_passing_score,
        "last_feedback": "pass" if feedback["passed"] else "fail",
    }


def render_user_prompt(template: str, payload: dict[str, Any]) -> str:
    public_spec = payload["public_spec"]
    history = json.dumps(payload["feedback_history"][-5:], indent=2)
    return template.format(
        prompt_id=public_spec["id"],
        visible_prompt=public_spec["visible_prompt"],
        min_length=public_spec["min_length"],
        max_length=public_spec["max_length"],
        must_contain_any=", ".join(public_spec["must_contain_any"]),
        feedback_history=history,
    )


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def write_candidate(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Phase 3A Attack B scorer optimization scaffold.")
    parser.add_argument("--prompt-set", type=Path, default=REPO_ROOT / "data" / "prompts" / "public.json")
    parser.add_argument("--filler-bank", type=Path, default=FROZEN_V51_FILLER_BANK)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--feedback-mode", choices=("raw_score", "pass_fail", "gray_box"), default="pass_fail")
    parser.add_argument("--max-iterations", type=int, default=20)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--provider", choices=("mock", "command"), default="mock")
    parser.add_argument("--provider-command", default="")
    parser.add_argument("--dry-run", action="store_true", help="Force the deterministic mock provider.")
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--run-dir", type=Path, default=DEFAULT_RUN_DIR)
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.max_iterations < 1:
        raise ValueError("--max-iterations must be at least 1")

    manifest_path = resolve_repo_path(args.manifest)
    if not manifest_path.exists():
        raise FileNotFoundError(
            f"Artifact manifest not found: {manifest_path}. Run tools/pin_v51_artifact.py first."
        )

    run_id = args.run_id or datetime.now(timezone.utc).strftime("attack_b_%Y%m%d_%H%M%S")
    run_dir = resolve_repo_path(args.run_dir) / run_id
    registry_path = resolve_repo_path(args.registry)
    filler_bank_path = resolve_repo_path(args.filler_bank)
    prompt_set_path = resolve_repo_path(args.prompt_set)
    provider = build_provider(args)

    system_prompt = SYSTEM_PROMPT.read_text(encoding="utf-8")
    user_template = USER_TEMPLATE.read_text(encoding="utf-8")
    specs = load_prompt_specs(prompt_set_path, limit=args.limit)
    validate_visible_prompt_specs(specs, source=prompt_set_path)
    scorer = build_v51_scorer(filler_bank_path)

    manifest_hash = sha256_file(manifest_path)
    print(f"Attack B run_id: {run_id}")
    print(f"Feedback mode: {args.feedback_mode}")
    print(f"Provider: {provider.name}")
    print(f"Artifact manifest: {manifest_path}")
    print(f"Artifact manifest SHA256: {manifest_hash}")
    print(f"Registry: {registry_path}")

    for spec in specs:
        feedback_history: list[dict[str, Any]] = []
        observed_best: dict[str, Any] = {}
        audit_best_score: int | None = None
        public_spec = spec_public_payload(spec)
        public_spec_hash = sha256_text(json.dumps(public_spec, sort_keys=True))

        for iteration in range(1, args.max_iterations + 1):
            provider_payload = {
                "attack": "B",
                "run_id": run_id,
                "iteration": iteration,
                "feedback_mode": args.feedback_mode,
                "public_spec": public_spec,
                "system_prompt": system_prompt,
                "user_prompt": render_user_prompt(
                    user_template,
                    {
                        "public_spec": public_spec,
                        "feedback_history": feedback_history,
                    },
                ),
                "feedback_history": feedback_history,
            }
            provider_result = provider.generate(provider_payload)
            candidate_text = provider_result.candidate_text.strip()
            candidate_hash = sha256_text(candidate_text)
            provider_name = str(provider_result.provider_metadata.get("provider", provider.name))
            incorporated = prior_feedback_incorporated(
                iteration=iteration,
                provider_name=provider_name,
                provider_metadata=provider_result.provider_metadata,
            )
            candidate_path = (
                run_dir
                / "candidates"
                / spec.id
                / f"iter_{iteration:03d}_{candidate_hash[:12]}.txt"
            )
            write_candidate(candidate_path, candidate_text)

            diagnostics = score_output(scorer, spec, candidate_text)
            feedback = feedback_for_mode(args.feedback_mode, diagnostics)
            observed_best = update_observed_best(args.feedback_mode, observed_best, feedback)
            score = int(diagnostics["v5_1_score"])
            audit_best_score = score if audit_best_score is None else max(audit_best_score, score)
            feedback_history.append(feedback)

            record = {
                "timestamp": utc_now(),
                "attack": "B",
                "run_id": run_id,
                "artifact_manifest": relative(manifest_path),
                "artifact_manifest_sha256": manifest_hash,
                "filler_bank": relative(filler_bank_path),
                "prompt_set": relative(prompt_set_path),
                "prompt_id": spec.id,
                "public_spec_hash": public_spec_hash,
                "feedback_mode": args.feedback_mode,
                "provider": provider.name,
                "provider_name": provider_name,
                "iteration": iteration,
                "candidate_hash": candidate_hash,
                "candidate_content_sha256": candidate_hash,
                "candidate_preview": preview_text(candidate_text),
                "candidate_text_path": relative(candidate_path),
                "prior_feedback_available": iteration > 1,
                "prior_feedback_incorporated": incorporated,
                "feedback_returned": feedback,
                "best_so_far": observed_best,
                "audit_best_score": audit_best_score,
                "private_evaluation_not_returned_to_attacker": diagnostics,
                "cost_estimate": provider_result.provider_metadata.get(
                    "cost_estimate",
                    {"input_tokens": None, "output_tokens": None, "estimated_usd": None},
                ),
                "provider_metadata": provider_result.provider_metadata,
            }
            append_jsonl(registry_path, record)
            print(
                f"{spec.id} iter={iteration} candidate={candidate_hash[:12]} "
                f"feedback={json.dumps(feedback, sort_keys=True)}"
            )

    print(f"Attack B scaffold run complete. Candidates: {run_dir}")
    print(f"Append-only registry: {registry_path}")


if __name__ == "__main__":
    main()
