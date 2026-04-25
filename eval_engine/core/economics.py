"""
economics.py — expected value and reward math.

All parameters are attacker-knowable (public burn level,
public reward curve, observed pass rates).
"""

from dataclasses import dataclass, field


@dataclass
class EconomicConfig:
    """
    Public economic parameters of the system.
    Values here are placeholders — tune to match the testnet deployment.
    """
    base_reward: int = 2000          # tokens minted per successful submission
    burn_per_attempt: int = 500      # burned regardless of outcome
    slash_penalty_bps: int = 5000    # % of reward lost on slash (50%)
    compute_cost_per_attempt: int = 50   # off-chain cost in token-equivalent


@dataclass
class AttemptOutcome:
    submission_id: str
    passed: bool
    slashed: bool
    score: int
    reward: int
    burned: int
    net_ev: int


@dataclass
class EpochLedger:
    """
    Tracks cumulative EV across an epoch.
    This is the key metric: a single-day EV check is insufficient;
    the cumulative integral over the epoch determines security.
    """
    epoch_number: int
    outcomes: list[AttemptOutcome] = field(default_factory=list)
    daily_totals: dict[int, int] = field(default_factory=dict)

    def record(self, day: int, outcome: AttemptOutcome) -> None:
        self.outcomes.append(outcome)
        self.daily_totals[day] = self.daily_totals.get(day, 0) + outcome.net_ev

    @property
    def cumulative_ev(self) -> int:
        return sum(o.net_ev for o in self.outcomes)

    @property
    def pass_count(self) -> int:
        return sum(1 for o in self.outcomes if o.passed)

    @property
    def slash_count(self) -> int:
        return sum(1 for o in self.outcomes if o.slashed)

    @property
    def pass_rate(self) -> float:
        if not self.outcomes:
            return 0.0
        return self.pass_count / len(self.outcomes)

    def daily_cumulative(self) -> list[tuple[int, int]]:
        """Returns [(day, cumulative_ev_through_day), ...]"""
        result = []
        running = 0
        for day in sorted(self.daily_totals.keys()):
            running += self.daily_totals[day]
            result.append((day, running))
        return result

    def breached(self) -> tuple[bool, int]:
        """
        Returns (was_ever_positive, first_day_positive).
        A breach is any day where cumulative EV crossed above zero.
        """
        for day, cum in self.daily_cumulative():
            if cum > 0:
                return True, day
        return False, -1


def compute_outcome(
    submission_id: str,
    passed: bool,
    slashed: bool,
    score: int,
    config: EconomicConfig,
) -> AttemptOutcome:
    """
    Public economic formula. An attacker knows this exactly.

    EV = reward_if_passed - burn - compute_cost - slash_penalty_if_slashed
    """
    reward = config.base_reward if passed else 0
    burned = config.burn_per_attempt

    if slashed:
        slash_amount = (config.base_reward * config.slash_penalty_bps) // 10_000
        slash_cost = slash_amount
    else:
        slash_cost = 0

    net = reward - burned - config.compute_cost_per_attempt - slash_cost

    return AttemptOutcome(
        submission_id=submission_id,
        passed=passed,
        slashed=slashed,
        score=score,
        reward=reward,
        burned=burned,
        net_ev=net,
    )
