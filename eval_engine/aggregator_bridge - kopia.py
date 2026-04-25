# eval_engine/aggregator_bridge.py
import sys
import json
import logging
from pathlib import Path

# Ensure the workspace root is in the path
# In venom_workspace/eval_engine/aggregator_bridge.py, parents[1] is venom_workspace/
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Also add eval_engine specifically if needed for sub-imports
EVAL_ENGINE_ROOT = REPO_ROOT / "eval_engine"
if str(EVAL_ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(EVAL_ENGINE_ROOT))

try:
    from attacks.v51_scoring import score_for_attack_c
except ImportError:
    # Fallback if imported from eval_engine directly
    from eval_engine.attacks.v51_scoring import score_for_attack_c

# Suppress all standard logging so it doesn't pollute stdout
logging.getLogger().setLevel(logging.CRITICAL)

def main():
    try:
        # Read exactly one line of JSON from stdin
        raw_input = sys.stdin.read().strip()
        if not raw_input:
            raise ValueError("No input provided on stdin")
            
        payload_data = json.loads(raw_input)
        
        # Extract fields
        payload_text = payload_data.get("payload", "")
        reference_text = payload_data.get("reference_answer", "")
        
        # Execute the v5.3.2 scoring logic
        # Default to mode="attack_c" is handled inside score_for_attack_c
        result = score_for_attack_c(payload_text, reference_text)
        
        # Print ONLY the JSON result to stdout for Node.js to capture
        print(json.dumps({
            "status": "success",
            "passes_threshold": result.get("passes_threshold", False),
            "final_score": result.get("score", 0.0),
            "diagnostics": result
        }))
        sys.exit(0)
        
    except Exception as e:
        # Output clean error JSON
        print(json.dumps({
            "status": "error",
            "message": str(e)
        }))
        sys.exit(1)

if __name__ == "__main__":
    main()
