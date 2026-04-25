"""
report.py — human-readable epoch report (now with full component diagnostics)
"""

def format_report(attacker_name: str, summary: dict, config: dict) -> str:
    lines = []
    lines.append("=" * 72)
    lines.append(f"Epoch Attack Report — {attacker_name}")
    lines.append("=" * 72)
    lines.append("")
    lines.append("Configuration:")
    for k, v in config.items():
        lines.append(f"  {k:.<36s} {v}")
    lines.append("")

    lines.append("Daily breakdown:")
    lines.append(
        f"  {'Day':>4} {'Attempts':>8} {'Passes':>8} {'PassRate':>9} "
        f"{'AvgScore':>9} {'DailyEV':>10} {'CumEV':>10}  "
        f"{'Len':>5} {'Kw':>5} {'Sem':>5} {'Deg':>5}"
    )
    for row in summary["daily"]:
        comp = row["component_averages"]
        lines.append(
            f"  {row['day']:>4} "
            f"{row['attempts']:>8} "
            f"{row['passes']:>8} "
            f"{row['pass_rate']:>9.3f} "
            f"{row['avg_score']:>9.1f} "
            f"{row['daily_ev']:>10,} "
            f"{row['cumulative_ev']:>10,}  "
            f"{comp.get('length_compliance', 0):>5.2f} "
            f"{comp.get('keyword_relevance', 0):>5.2f} "
            f"{comp.get('semantic_coherence', 0):>5.2f} "
            f"{comp.get('non_degeneracy', 0):>5.2f}"
        )
    lines.append("")

    lines.append("Verdict:")
    if summary["breached"]:
        lines.append(f"  *** SYSTEM BREACHED on day {summary['breach_day']} ***")
        lines.append(f"  Attacker reached positive cumulative EV.")
        lines.append(f"  Final cumulative EV: {summary['final_cumulative_ev']:,}")
    else:
        lines.append(f"  SYSTEM SECURE against this attacker tier.")
        lines.append(f"  Final cumulative EV: {summary['final_cumulative_ev']:,} (net loss)")

    lines.append("=" * 72)
    return "\n".join(lines)