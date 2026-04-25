"""
v5.2 Calibration Harness for Attack B (Adversarial Payloads)
Implements the 2-Oracle Consensus Logic (Gemini + Grok)
"""

import argparse
import json
import os
import sys
from pathlib import Path

# Add the project root to sys.path to allow absolute imports if needed
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / 'eval_engine'))

# Import the v5.2 scoring logic
try:
    from attacks.v51_scoring import score_payload, evaluate_2_oracle_consensus
except ImportError:
    # Fallback for different execution contexts
    from v51_scoring import score_payload, evaluate_2_oracle_consensus

def main():
    parser = argparse.ArgumentParser(description="Run V5.2 Calibration Epoch")
    parser.add_argument("--prompts", type=Path, required=True, help="Path to the JSONL fixture")
    parser.add_argument("--output", type=Path, required=True, help="Directory to save results")
    parser.add_argument("--model", action="append", help="Models to simulate (Gemini, Grok)")
    parser.add_argument("--scoring", default="v5.2", help="Scoring version")
    parser.add_argument("--consensus", default="2-oracle", help="Consensus mode")
    
    args = parser.parse_args()

    if not args.prompts.exists():
        print(f"Error: Fixture not found at {args.prompts}")
        sys.exit(1)

    # Load payloads
    payloads = []
    with open(args.prompts, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                payloads.append(json.loads(line))

    results = []
    
    print(f"\n" + "="*60)
    print(f"V5.2 CALIBRATION EPOCH 001")
    print(f"Consensus: {args.consensus}")
    print(f"Models:    {', '.join(args.model) if args.model else 'None specified'}")
    print("="*60 + "\n")

    passes = 0
    for p in payloads:
        payload_text = p["payload"]
        variant_id = p["id"]
        
        # In calibration mode, we run the deterministic v5.2 engine.
        # This simulates both Oracle A and Oracle B scoring the payload.
        # Since the logic is deterministic, they will return the same score.
        score_data = score_payload(payload_text, "", "")
        score = score_data["score"]
        
        # Evaluate consensus
        consensus = evaluate_2_oracle_consensus(score, score, payload_text)
        
        result = {
            "id": variant_id,
            "variant": p.get("variant"),
            "individual_score": score,
            "reasons": score_data["reasons"],
            "consensus": consensus
        }
        results.append(result)
        
        if consensus["consensus_pass"]:
            passes += 1
            status_icon = "✅ PASS"
        else:
            status_icon = "❌ FAIL"
            
        print(f"[{status_icon}] {variant_id:<15} | Score: {score:+.2f} | Status: {consensus['status']}")
        if score_data["reasons"]:
            print(f"      Reasons: {', '.join(score_data['reasons'])}")

    # Summary
    pass_rate = (passes / len(payloads)) * 100 if payloads else 0
    print(f"\n" + "-"*60)
    print(f"Epoch Summary: {passes}/{len(payloads)} Passed ({pass_rate:.1f}%)")
    print("-"*60)

    # Save output
    args.output.mkdir(parents=True, exist_ok=True)
    output_file = args.output / "v52_calibration_results.json"
    
    summary = {
        "metadata": {
            "scoring_version": args.scoring,
            "consensus_mode": args.consensus,
            "models": args.model,
            "timestamp": "2026-04-24",
            "summary": {
                "total": len(payloads),
                "passes": passes,
                "pass_rate": pass_rate
            }
        },
        "results": results
    }
    
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    
    print(f"Full results saved to: {output_file}\n")

if __name__ == "__main__":
    main()
