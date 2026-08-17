"""食事の一覧と投票窓。現在時刻は引数で受け取り、データベースには触れない。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from . import config


@dataclass(frozen=True, order=True)
class Meal:
    day: date
    kind: str


def meal_in_period(kind: str, day: date) -> bool:
    first, last = config.PERIOD[("meal", kind)]
    return first <= day <= last


def all_meals() -> list[Meal]:
    """期間内の全食事を時系列で返す。締切の順と一致する。"""
    first = min(config.PERIOD[("meal", k)][0] for k in config.MEALS)
    last = max(config.PERIOD[("meal", k)][1] for k in config.MEALS)
    out: list[Meal] = []
    day = first
    while day <= last:
        for kind in config.MEALS:
            if meal_in_period(kind, day):
                out.append(Meal(day, kind))
        day += timedelta(days=1)
    return out


def vote_deadline(meal: Meal) -> datetime:
    shift, close_hour = config.VOTE_DEADLINE[meal.kind]
    base = meal.day + timedelta(days=shift)
    return datetime(base.year, base.month, base.day, close_hour, tzinfo=config.TZ)


def vote_state(meal: Meal, now: datetime) -> str:
    """受付開始は設けない。締切まではいつでも挙手できる。"""
    return "open" if now < vote_deadline(meal) else "closed"


def visible_meals(now: datetime) -> list[Meal]:
    """締切が未来の先頭 3 件と、直近で締め切った 1 件。"""
    meals = all_meals()
    closed = [m for m in meals if vote_state(m, now) == "closed"]
    upcoming = [m for m in meals if vote_state(m, now) != "closed"]
    return closed[-1:] + upcoming[:3]


def format_meal(meal: Meal) -> str:
    weekday = config.WEEKDAYS[meal.day.weekday()]
    return f"{meal.day.month}/{meal.day.day}({weekday}) {config.MEAL_LABELS[meal.kind]}"
