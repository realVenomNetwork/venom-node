"""Write a reproducibility manifest for the frozen V5.1 scorer artifact."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / 'eval_engine'))

os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")

from core import evaluator_proxy


DEFAULT_MANIFEST_PATH = REPO_ROOT / "docs" / "eval" / "V5_1_ARTIFACT_MANIFEST.json"
FROZEN_FILLER_BANK = REPO_ROOT / "data" / "prompts" / "v5.1_contrastive_filler_bank.json"
MODEL_NAME = "BAAI/bge-base-en-v1.5"
MODEL_WEIGHT_FILENAMES = {"model.safetensors", "pytorch_model.bin"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def torch_info() -> dict[str, Any]:
    info: dict[str, Any] = {"installed": False}
    try:
        import torch
    except Exception as exc:  # pragma: no cover - defensive environment capture
        info["import_error"] = repr(exc)
        return info

    info.update(
        {
            "installed": True,
            "version": getattr(torch, "__version__", None),
            "cuda_available": bool(torch.cuda.is_available()),
            "cuda_version": getattr(torch.version, "cuda", None),
            "device_count": int(torch.cuda.device_count()) if torch.cuda.is_available() else 0,
            "mode": "cuda" if torch.cuda.is_available() else "cpu",
        }
    )
    if torch.cuda.is_available():
        info["devices"] = [torch.cuda.get_device_name(idx) for idx in range(torch.cuda.device_count())]
    return info


def load_filler_bank_config(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    formula = payload.get("scoring_formula", {})
    parameters = formula.get("parameters", {})
    filler_bank = payload.get("filler_bank", [])
    return {
        "meta": payload.get("meta", {}),
        "pattern_count": len(filler_bank),
        "lambda": parameters.get("LAMBDA", {}).get("start_value"),
        "rescale": parameters.get("RESCALE", {}).get("start_value"),
        "ids": [entry.get("id") for entry in filler_bank if isinstance(entry, dict)],
    }


def aggregate_file_hash(file_records: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for record in sorted(file_records, key=lambda item: item["name"]):
        digest.update(record["name"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(record["sha256"].encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def model_cache_artifacts(model_name: str) -> dict[str, Any]:
    """Hash the strongest local model artifact available without downloading."""
    try:
        from huggingface_hub import scan_cache_dir
    except Exception as exc:  # pragma: no cover - environment capture
        return {
            "model_name_or_path": model_name,
            "pinned": False,
            "error": f"could not import huggingface_hub.scan_cache_dir: {exc!r}",
        }

    try:
        cache = scan_cache_dir()
    except Exception as exc:  # pragma: no cover - environment capture
        return {
            "model_name_or_path": model_name,
            "pinned": False,
            "error": f"could not scan huggingface cache: {exc!r}",
        }

    repo = next(
        (
            item
            for item in cache.repos
            if item.repo_id == model_name and item.repo_type in {None, "model"}
        ),
        None,
    )
    if repo is None:
        return {
            "model_name_or_path": model_name,
            "pinned": False,
            "error": "model not found in local Hugging Face cache",
        }

    revisions = sorted(repo.revisions, key=lambda rev: rev.last_modified or 0, reverse=True)
    if not revisions:
        return {
            "model_name_or_path": model_name,
            "pinned": False,
            "error": "model cache repo has no revisions",
        }

    revision = revisions[0]
    files = sorted(revision.files, key=lambda item: item.file_name)
    weight_files = [item for item in files if item.file_name in MODEL_WEIGHT_FILENAMES]
    artifact_files = weight_files or files
    file_records = [
        {
            "name": item.file_name,
            "path": str(item.file_path),
            "size_on_disk": item.size_on_disk,
            "sha256": sha256_file(Path(item.file_path)),
        }
        for item in artifact_files
    ]

    return {
        "model_name_or_path": model_name,
        "pinned": True,
        "pin_type": "model_weight_file_sha256" if weight_files else "full_snapshot_file_sha256",
        "repo_id": repo.repo_id,
        "repo_type": repo.repo_type,
        "revision_commit": revision.commit_hash,
        "snapshot_path": str(revision.snapshot_path),
        "hashed_file_count": len(file_records),
        "aggregate_sha256": aggregate_file_hash(file_records),
        "files": file_records,
    }


def build_manifest(filler_bank_path: Path) -> dict[str, Any]:
    evaluator_path = Path(evaluator_proxy.__file__).resolve()
    packages = {
        name: package_version(name)
        for name in (
            "sentence-transformers",
            "torch",
            "transformers",
            "numpy",
            "scipy",
            "scikit-learn",
            "huggingface-hub",
        )
    }

    return {
        "manifest_version": "phase3a.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "repo_root": str(REPO_ROOT),
        "python": {
            "version": sys.version,
            "executable": sys.executable,
            "platform": platform.platform(),
        },
        "packages": packages,
        "torch": torch_info(),
        "sentence_transformer": {
            "model_name_or_path": MODEL_NAME,
            "source": "core.evaluator_proxy.ScoringEngine",
            "local_artifacts": model_cache_artifacts(MODEL_NAME),
        },
        "frozen_v5_1": {
            "filler_bank_path": str(filler_bank_path.relative_to(REPO_ROOT)),
            "filler_bank_sha256": sha256_file(filler_bank_path),
            "pass_threshold": evaluator_proxy.PASS_THRESHOLD,
            "lambda": evaluator_proxy.DEFAULT_CONTRASTIVE_LAMBDA,
            "rescale": evaluator_proxy.DEFAULT_CONTRASTIVE_RESCALE,
            "scoring_weights": dict(evaluator_proxy.SCORING_WEIGHTS),
            "max_robustness_penalty": evaluator_proxy.MAX_ROBUSTNESS_PENALTY,
            "max_stuffing_penalty": evaluator_proxy.MAX_STUFFING_PENALTY,
            "filler_bank_config": load_filler_bank_config(filler_bank_path),
        },
        "source_hashes": {
            "core/evaluator_proxy.py": sha256_file(evaluator_path),
        },
        "notes": [
            "This manifest identifies the local frozen V5.1 scorer configuration for Phase 3A attack runs.",
            "When available in the local Hugging Face cache, model weight files are pinned by SHA256.",
            "Attack harnesses should record this manifest path and SHA256 with every run.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Pin the local frozen V5.1 scorer artifact.")
    parser.add_argument("--out", type=Path, default=DEFAULT_MANIFEST_PATH)
    parser.add_argument("--filler-bank", type=Path, default=FROZEN_FILLER_BANK)
    args = parser.parse_args()

    filler_bank_path = args.filler_bank.resolve()
    if not filler_bank_path.exists():
        raise FileNotFoundError(f"V5.1 filler bank not found: {filler_bank_path}")

    manifest = build_manifest(filler_bank_path)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote V5.1 artifact manifest: {args.out}")
    print(f"Filler bank SHA256: {manifest['frozen_v5_1']['filler_bank_sha256']}")
    print(f"Evaluator SHA256: {manifest['source_hashes']['core/evaluator_proxy.py']}")
    artifacts = manifest["sentence_transformer"]["local_artifacts"]
    print(f"Model artifact pinned: {artifacts.get('pinned')}")
    print(f"Model artifact hash: {artifacts.get('aggregate_sha256')}")


if __name__ == "__main__":
    main()
