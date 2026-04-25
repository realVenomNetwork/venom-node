"""
evaluator_proxy.py - v5.0 (contrastive semantics)
"""

from __future__ import annotations

import hashlib
import inspect
import json
import random
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from sentence_transformers import SentenceTransformer, util


SCORING_WEIGHTS = {
    "length_compliance": 0.12,
    "keyword_relevance": 0.12,
    "semantic_coherence": 0.60,
    "non_degeneracy": 0.08,
    "non_empty": 0.04,
    "no_truncation": 0.04,
}

MAX_ROBUSTNESS_PENALTY = 0.40
MAX_STUFFING_PENALTY = 0.20

PASS_THRESHOLD = 55
SLASH_THRESHOLD = 20
DEFAULT_CONTRASTIVE_LAMBDA = 1.0
DEFAULT_CONTRASTIVE_RESCALE = 2.0
DEFAULT_FILLER_BANK_PATH = (
    Path(__file__).resolve().parents[1] / "data" / "prompts" / "v5_contrastive_filler_bank.json"
)


@dataclass
class PromptSpec:
    id: str
    tier: str
    prompt: str
    reference_answer: str
    min_length: int
    max_length: int
    must_contain_any: list[str]
    weight: float = 1.0
    adversarial_variants: list[str] = field(default_factory=list)


@dataclass
class EvaluationResult:
    prompt_id: str
    raw_score: float
    components: dict[str, float]
    stuffing_flagged: bool
    robustness_delta: float


@dataclass
class SubmissionReport:
    attempt_id: str
    selected_prompt_ids: list[str]
    per_prompt_results: list[EvaluationResult]
    aggregate_score: int
    passed: bool
    slashed: bool
    robustness_penalty: float
    stuffing_penalty: float
    component_averages: dict[str, float] = field(default_factory=dict)


class PromptSelector:
    PUBLIC_N = 3
    ROTATING_N = 5
    HIDDEN_N = 4

    def __init__(self, public_pool, rotating_pool, hidden_pool):
        self.public = public_pool
        self.rotating = rotating_pool
        self.hidden = hidden_pool

    def select(self, submission_id: str, epoch: int) -> list[PromptSpec]:
        seed = int(hashlib.sha256(f"{submission_id}:{epoch}".encode()).hexdigest(), 16) % (2**32)
        rng = random.Random(seed)
        return (
            rng.sample(self.public, k=min(self.PUBLIC_N, len(self.public)))
            + rng.sample(self.rotating, k=min(self.ROTATING_N, len(self.rotating)))
            + rng.sample(self.hidden, k=min(self.HIDDEN_N, len(self.hidden)))
        )


class ScoringEngine:
    def __init__(self, filler_bank_path: Optional[Path] = None):
        self.model = SentenceTransformer("BAAI/bge-base-en-v1.5")
        self.contrastive_lambda = DEFAULT_CONTRASTIVE_LAMBDA
        self.contrastive_rescale = DEFAULT_CONTRASTIVE_RESCALE
        self.filler_bank_embeddings = None
        self.filler_bank_path = Path(filler_bank_path or DEFAULT_FILLER_BANK_PATH)
        self.filler_bank_size = 0
        self._load_contrastive_config(self.filler_bank_path)

    def _load_contrastive_config(self, filler_bank_path: Path) -> None:
        try:
            with filler_bank_path.open(encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            print(
                f"Evaluator filler bank: path={filler_bank_path} load_error={exc}",
                file=sys.stderr,
            )
            return

        formula = payload.get("scoring_formula", {})
        parameters = formula.get("parameters", {})
        self.contrastive_lambda = float(
            parameters.get("LAMBDA", {}).get("start_value", DEFAULT_CONTRASTIVE_LAMBDA)
        )
        self.contrastive_rescale = float(
            parameters.get("RESCALE", {}).get("start_value", DEFAULT_CONTRASTIVE_RESCALE)
        )

        filler_texts = []
        for entry in payload.get("filler_bank", []):
            if not isinstance(entry, dict):
                continue
            text = entry.get("text", "").strip()
            if text:
                filler_texts.append(text)

        if filler_texts:
            self.filler_bank_embeddings = self.model.encode(
                filler_texts,
                convert_to_tensor=True,
            )
        self.filler_bank_size = len(filler_texts)
        print(
            "Evaluator filler bank: "
            f"path={filler_bank_path} "
            f"lambda={self.contrastive_lambda} "
            f"rescale={self.contrastive_rescale} "
            f"patterns={self.filler_bank_size}",
            file=sys.stderr,
        )

    def score(self, output: str, spec: PromptSpec) -> EvaluationResult:
        components = self._compute_components(output, spec)
        raw = sum(SCORING_WEIGHTS[k] * v for k, v in components.items())
        stuffing = self._detect_stuffing(output, spec)
        return EvaluationResult(
            prompt_id=spec.id,
            raw_score=raw,
            components=components,
            stuffing_flagged=stuffing,
            robustness_delta=0.0,
        )

    def _compute_components(self, output: str, spec: PromptSpec) -> dict[str, float]:
        words = output.split()
        wc = len(words)
        non_empty = 1.0 if wc > 0 else 0.0

        if wc == 0:
            length_compliance = 0.0
        elif spec.min_length <= wc <= spec.max_length:
            length_compliance = 1.0
        elif wc < spec.min_length:
            length_compliance = wc / spec.min_length
        else:
            length_compliance = spec.max_length / wc

        no_truncation = 1.0 if re.search(r"[.!?]\s*$", output.strip()) else 0.3

        if wc > 0:
            unique_ratio = len(set(w.lower() for w in words)) / wc
            non_degeneracy = min(1.0, unique_ratio / 0.5)
        else:
            non_degeneracy = 0.0

        keyword_relevance = self._keyword_relevance(output, words, spec)
        semantic_coherence = self._semantic_proxy(output, spec)

        return {
            "non_empty": non_empty,
            "length_compliance": length_compliance,
            "no_truncation": no_truncation,
            "non_degeneracy": non_degeneracy,
            "keyword_relevance": keyword_relevance,
            "semantic_coherence": semantic_coherence,
        }

    def _keyword_relevance(self, output: str, words: list[str], spec: PromptSpec) -> float:
        if not spec.must_contain_any:
            return 1.0
        lower = output.lower()
        matched = [kw for kw in spec.must_contain_any if kw.lower() in lower]
        base = min(1.0, len(matched) / max(1, len(spec.must_contain_any)))
        if words:
            keyword_count = sum(lower.count(kw.lower()) for kw in matched)
            density = keyword_count / len(words)
            if density > 0.15:
                penalty = min(0.5, (density - 0.15) * 1.43)
                base *= 1.0 - penalty
        return base

    def _semantic_proxy(self, output: str, spec: PromptSpec) -> float:
        if not spec.reference_answer or not spec.reference_answer.strip():
            return 0.5
        emb_out = self.model.encode(output, convert_to_tensor=True)
        emb_ref = self.model.encode(spec.reference_answer, convert_to_tensor=True)
        sim_ref = max(0.0, float(util.cos_sim(emb_out, emb_ref)[0][0]))

        if self.filler_bank_embeddings is None:
            return min(1.0, sim_ref)

        filler_sims = util.cos_sim(emb_out, self.filler_bank_embeddings)[0]
        sim_filler = max(0.0, float(filler_sims.max().item()))
        contrastive = max(0.0, sim_ref - (self.contrastive_lambda * sim_filler))
        return min(1.0, contrastive * self.contrastive_rescale)

    def _detect_stuffing(self, output: str, spec: PromptSpec) -> bool:
        if not spec.must_contain_any:
            return False
        words = output.lower().split()
        if not words:
            return False
        hits = sum(words.count(kw.lower()) for kw in spec.must_contain_any)
        return (hits / len(words)) > 0.15


class EvaluatorProxy:
    def __init__(self, selector: PromptSelector, scorer: ScoringEngine):
        self.selector = selector
        self.scorer = scorer

    def _generate_output(self, output_generator, prompt: str, spec: PromptSpec) -> str:
        """
        Backward-compatible attacker adapter.

        Existing attackers only accept `generate_output(prompt)`, while the
        mechanical tier can now opt into `generate_output(prompt, spec)` to use
        prompt metadata such as length bands and required keywords.
        """
        try:
            signature = inspect.signature(output_generator)
        except (TypeError, ValueError):
            return output_generator(prompt)

        params = list(signature.parameters.values())
        if any(p.kind == inspect.Parameter.VAR_POSITIONAL for p in params):
            return output_generator(prompt, spec)

        positional = [
            p
            for p in params
            if p.kind in (
                inspect.Parameter.POSITIONAL_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            )
        ]
        if len(positional) >= 2:
            return output_generator(prompt, spec)
        return output_generator(prompt)

    def evaluate_submission(self, submission_id: str, epoch: int, output_generator) -> SubmissionReport:
        prompts = self.selector.select(submission_id, epoch)
        per_prompt: list[EvaluationResult] = []

        for spec in prompts:
            if spec.tier == "hidden":
                output = self._generate_output(output_generator, "", spec)
            else:
                output = self._generate_output(output_generator, spec.prompt, spec)

            result = self.scorer.score(output, spec)

            if spec.adversarial_variants:
                variant_scores = []
                for variant in spec.adversarial_variants[:2]:
                    variant_output = self._generate_output(output_generator, variant, spec)
                    variant_result = self.scorer.score(variant_output, spec)
                    variant_score = sum(
                        SCORING_WEIGHTS[k] * v for k, v in variant_result.components.items()
                    )
                    variant_scores.append(variant_score)
                avg_variant = sum(variant_scores) / len(variant_scores)
                result.robustness_delta = max(0.0, result.raw_score - avg_variant)

            per_prompt.append(result)

        weights = [p.weight for p in prompts]
        raw_scores = [r.raw_score for r in per_prompt]
        weighted_avg = sum(w * s for w, s in zip(weights, raw_scores)) / sum(weights)

        mean_robustness = sum(r.robustness_delta for r in per_prompt) / len(per_prompt)
        robustness_penalty = min(MAX_ROBUSTNESS_PENALTY, mean_robustness * 0.5)

        flagged = sum(1 for r in per_prompt if r.stuffing_flagged)
        stuffing_penalty = min(MAX_STUFFING_PENALTY, (flagged / len(per_prompt)) * 0.4)

        final_float = max(0.0, weighted_avg - robustness_penalty - stuffing_penalty)

        component_averages = {}
        for comp in SCORING_WEIGHTS:
            vals = [r.components.get(comp, 0.0) for r in per_prompt]
            component_averages[comp] = sum(vals) / len(vals) if vals else 0.0

        final_score = round(final_float * 100)

        return SubmissionReport(
            attempt_id=submission_id,
            selected_prompt_ids=[p.id for p in prompts],
            per_prompt_results=per_prompt,
            aggregate_score=final_score,
            passed=final_score >= PASS_THRESHOLD,
            slashed=final_score < SLASH_THRESHOLD,
            robustness_penalty=robustness_penalty,
            stuffing_penalty=stuffing_penalty,
            component_averages=component_averages,
        )
