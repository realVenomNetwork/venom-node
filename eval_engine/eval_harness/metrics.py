"""
metrics.py — pass rate tracking and EV accumulation (with component diagnostics)
"""

from dataclasses import dataclass, field
from collections import defaultdict


@dataclass
class DailyMetrics:
    day: int
    attempts: int = 0
    passes: int = 0
    slashes: int = 0
    net_ev: int = 0
    score_sum: int = 0
    category_passes: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    category_attempts: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    # v4 diagnostic: average of each scoring component across all submissions that day
    component_sum: dict[str, float] = field(default_factory=lambda: defaultdict(float))
    component_count: int = 0

    @property
    def pass_rate(self) -> float:
        return self.passes / self.attempts if self.attempts else 0.0

    @property
    def avg_score(self) -> float:
        return self.score_sum / self.attempts if self.attempts else 0.0

    def category_pass_rate(self, category: str) -> float:
        attempts = self.category_attempts.get(category, 0)
        return self.category_passes.get(category, 0) / attempts if attempts else 0.0

    def component_average(self, comp: str) -> float:
        return self.component_sum[comp] / self.component_count if self.component_count else 0.0


class MetricsTracker:
    def __init__(self):
        self.daily: dict[int, DailyMetrics] = {}
        self._current_day: int = 1

    def set_day(self, day: int) -> None:
        self._current_day = day
        if day not in self.daily:
            self.daily[day] = DailyMetrics(day=day)

    def record(
        self,
        passed: bool,
        slashed: bool,
        score: int,
        net_ev: int,
        prompt_categories: list[str],
        component_averages: dict[str, float],   # ← NEW
    ) -> None:
        m = self.daily.setdefault(self._current_day, DailyMetrics(day=self._current_day))
        m.attempts += 1
        m.score_sum += score
        m.net_ev += net_ev
        if passed:
            m.passes += 1
        if slashed:
            m.slashes += 1
        for cat in prompt_categories:
            m.category_attempts[cat] += 1
            if passed:
                m.category_passes[cat] += 1

        # Record component averages for this submission
        m.component_count += 1
        for comp, value in component_averages.items():
            m.component_sum[comp] += value

    def summary(self) -> dict:
        sorted_days = sorted(self.daily.keys())
        cumulative_ev = 0
        daily_rows = []
        breach_day = None
        for d in sorted_days:
            m = self.daily[d]
            cumulative_ev += m.net_ev
            if cumulative_ev > 0 and breach_day is None:
                breach_day = d

            daily_rows.append({
                "day": d,
                "attempts": m.attempts,
                "passes": m.passes,
                "pass_rate": round(m.pass_rate, 3),
                "avg_score": round(m.avg_score, 1),
                "daily_ev": m.net_ev,
                "cumulative_ev": cumulative_ev,
                "component_averages": {
                    comp: round(m.component_average(comp), 3)
                    for comp in ["length_compliance", "keyword_relevance",
                                 "semantic_coherence", "non_degeneracy"]
                }
            })
        return {
            "breach_day": breach_day,
            "breached": breach_day is not None,
            "final_cumulative_ev": cumulative_ev,
            "daily": daily_rows,
        }