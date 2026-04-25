"""Command-provider adapter for local Ollama models.

Reads the Attack B provider payload as JSON on stdin and emits JSON with a
candidate answer plus provider metadata. No hosted services or secrets are
used; this requires an already-installed local Ollama model.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any


def build_prompt(payload: dict[str, Any]) -> str:
    feedback_history = payload.get("feedback_history", [])
    prior_feedback = bool(feedback_history)
    guardrail = (
        "You must write only the next candidate answer. "
        "Use the feedback history if present, but do not ask for hidden prompts, references, "
        "filler bank entries, raw scores, embeddings, or evaluator internals. "
        "Do not include analysis or markdown fences."
    )
    return "\n\n".join(
        [
            payload.get("system_prompt", ""),
            guardrail,
            payload.get("user_prompt", ""),
            f"Prior feedback available: {prior_feedback}",
        ]
    ).strip()


def clean_candidate(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    prefixes = ("Candidate:", "Answer:", "Output:")
    for prefix in prefixes:
        if cleaned.lower().startswith(prefix.lower()):
            cleaned = cleaned[len(prefix):].strip()
    return cleaned


def generate_with_api(
    *,
    host: str,
    model: str,
    prompt: str,
    timeout: int,
    num_predict: int,
) -> tuple[str, dict[str, Any]]:
    request = urllib.request.Request(
        host.rstrip("/") + "/api/generate",
        data=json.dumps(
            {
                "model": model,
                "prompt": prompt,
                "stream": True,
                "options": {
                    "temperature": 0.7,
                    "num_predict": num_predict,
                },
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    chunks: list[str] = []
    final_payload: dict[str, Any] = {}
    with urllib.request.urlopen(request, timeout=timeout) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8").strip()
            if not line:
                continue
            payload = json.loads(line)
            chunks.append(str(payload.get("response", "")))
            if payload.get("done"):
                final_payload = payload
                break
    generation_metadata = {
        key: final_payload.get(key)
        for key in (
            "done",
            "done_reason",
            "total_duration",
            "load_duration",
            "prompt_eval_count",
            "prompt_eval_duration",
            "eval_count",
            "eval_duration",
        )
        if key in final_payload
    }
    return "".join(chunks), generation_metadata


def generate_with_cli(*, model: str, prompt: str, timeout: int) -> tuple[str, dict[str, Any]]:
    completed = subprocess.run(
        ["ollama", "run", model, prompt],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=True,
    )
    return completed.stdout, {"returncode": completed.returncode}


def main() -> None:
    parser = argparse.ArgumentParser(description="Attack B local Ollama command provider.")
    parser.add_argument("--model", default="llama3.2:3b")
    parser.add_argument("--host", default="http://127.0.0.1:11434")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--num-predict", type=int, default=260)
    parser.add_argument("--transport", choices=("api", "cli"), default="api")
    args = parser.parse_args()

    payload = json.loads(sys.stdin.read())
    prompt = build_prompt(payload)
    if args.transport == "api":
        raw_output, generation_metadata = generate_with_api(
            host=args.host,
            model=args.model,
            prompt=prompt,
            timeout=args.timeout,
            num_predict=args.num_predict,
        )
    else:
        raw_output, generation_metadata = generate_with_cli(
            model=args.model,
            prompt=prompt,
            timeout=args.timeout,
        )
    candidate = clean_candidate(raw_output)
    if not candidate:
        raise RuntimeError("Ollama returned an empty candidate.")

    public_spec = payload.get("public_spec", {})
    candidate_word_count = len(candidate.split())
    min_length = int(public_spec.get("min_length", 0) or 0)
    output = {
        "candidate": candidate,
        "metadata": {
            "provider": "ollama",
            "model": args.model,
            "transport": args.transport,
            "host": args.host if args.transport == "api" else None,
            "timeout": args.timeout,
            "num_predict": args.num_predict if args.transport == "api" else None,
            "generation_metadata": generation_metadata,
            "used_feedback": bool(payload.get("feedback_history")),
            "prior_feedback_incorporated": bool(payload.get("feedback_history")),
            "candidate_word_count": candidate_word_count,
            "below_visible_min_length": bool(min_length and candidate_word_count < min_length),
            "cost_estimate": {
                "input_tokens": None,
                "output_tokens": candidate_word_count,
                "estimated_usd": 0.0,
            },
        },
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
