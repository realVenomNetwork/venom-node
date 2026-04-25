#!/usr/bin/env python3
"""
eval_engine/aggregator_bridge.py

Lightweight stdin/stdout bridge for the Multi-Oracle Aggregator.
Reads a single JSON object from stdin containing:
  {
    "payload": "...",
    "reference_answer": "..."
  }

Outputs a single JSON line to stdout:
  {
    "status": "success" | "error",
    "passes_threshold": bool,
    "final_score": float,
    "diagnostics": {...}
  }

This script is designed to be spawned by Node.js child_process.
"""

import sys
import json
import logging
from pathlib import Path

# --- Path Setup (Robust for venom_workspace layout) ---
# When executed as: python eval_engine/aggregator_bridge.py
# __file__ = .../venom_workspace/eval_engine/aggregator_bridge.py
# parents[1] = .../venom_workspace
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Also ensure eval_engine is importable for submodules
EVAL_ROOT = REPO_ROOT / "eval_engine"
if str(EVAL_ROOT) not in sys.path:
    sys.path.insert(0, str(EVAL_ROOT))

# --- Import the scoring engine (this can take 10-60s on first run while loading sentence-transformers) ---
sys.stderr.write("Loading v5.3.2 scoring model (first run may take 30-90s)...\n")
sys.stderr.flush()
try:
    from eval_engine.attacks.v51_scoring import score_for_attack_c
except ImportError as e:
    print(json.dumps({
        "status": "error",
        "message": f"Failed to import score_for_attack_c: {e}. Check sys.path: {sys.path}"
    }))
    sys.exit(1)

# Suppress all logging to keep stdout clean for Node.js
logging.getLogger().setLevel(logging.CRITICAL)
for handler in logging.root.handlers[:]:
    logging.root.removeHandler(handler)

def main():
    try:
        raw_input = sys.stdin.read().strip()
        if not raw_input:
            raise ValueError("No input provided on stdin")

        payload_data = json.loads(raw_input)

        payload_text = payload_data.get("payload", "")
        reference_text = payload_data.get("reference_answer", "")

        if not payload_text:
            raise ValueError("Missing 'payload' field in input JSON")

        # Call the v5.3.2 hybrid scorer (Attack C mode by default)
        result = score_for_attack_c(payload_text, reference_text)

        # Return clean JSON to Node.js
        print(json.dumps({
            "status": "success",
            "passes_threshold": result.get("passes_threshold", False),
            "final_score": result.get("score", 0.0),
            "diagnostics": result
        }, indent=None))
        sys.exit(0)

    except Exception as e:
        print(json.dumps({
            "status": "error",
            "message": str(e)
        }))
        sys.exit(1)

if __name__ == "__main__":
    main()