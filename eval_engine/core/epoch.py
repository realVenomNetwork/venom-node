"""
epoch.py — epoch lifecycle: rotation, reveal, reset.

Epoch boundaries reset the attacker's adaptation gains.
The SDK simulates this by rotating the visible rotating-tier prompts
at each epoch boundary. Hidden prompts remain hidden.
"""

from dataclasses import dataclass
from typing import Optional

from .evaluator_proxy import PromptSpec


@dataclass
class EpochConfig:
    duration_days: int = 7
    rotating_reveal_lead_hours: int = 24


class EpochManager:
    """
    Manages epoch state. The attacker learns what it knows about
    rotating prompts ONLY after they are revealed at epoch start
    (or lead-hours before, per the public spec).
    """

    def __init__(
        self,
        config: EpochConfig,
        rotating_pools_by_epoch: dict[int, list[PromptSpec]],
    ):
        """
        Args:
            config: epoch timing configuration
            rotating_pools_by_epoch: mapping of epoch number → rotating pool
                for that epoch. Caller is responsible for pre-populating
                this structure (in real system, this is committed on-chain).
        """
        self.config = config
        self.rotating_pools = rotating_pools_by_epoch
        self.current_epoch = 1

    def current_rotating_pool(self) -> list[PromptSpec]:
        return self.rotating_pools.get(self.current_epoch, [])

    def advance_to(self, epoch: int) -> None:
        if epoch not in self.rotating_pools:
            raise ValueError(
                f"No rotating pool configured for epoch {epoch}. "
                f"Populate rotating_pools_by_epoch before running."
            )
        self.current_epoch = epoch

    def is_epoch_boundary(self, day: int) -> bool:
        return (day - 1) % self.config.duration_days == 0 and day > 1

    def day_within_epoch(self, day: int) -> int:
        return ((day - 1) % self.config.duration_days) + 1
