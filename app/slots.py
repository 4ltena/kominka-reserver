"""風呂の枠と予約可否。現在時刻は引数で受け取り、データベースには触れない。"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from . import config


def slot_starts(section: str) -> tuple[str, ...]:
    start_hour, end_hour = config.SECTION_HOURS[section]
    starts = []
    minute = start_hour * 60
    end = end_hour * 60
    while minute < end:
        starts.append(f"{minute // 60:02d}:{minute % 60:02d}")
        minute += config.SLOT_MINUTES
    return tuple(starts)


def section_in_period(section: str, day: date) -> bool:
    first, last = config.PERIOD[("bath", section)]
    return first <= day <= last


def sections_for_date(day: date) -> tuple[str, ...]:
    return tuple(s for s in config.SECTIONS if section_in_period(s, day))


def slot_datetime(day: date, slot: str) -> datetime:
    hour, minute = (int(part) for part in slot.split(":"))
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=config.TZ)


def selectable_dates(now: datetime) -> list[date]:
    today = now.date()
    return [d for d in (today, today + timedelta(days=1)) if sections_for_date(d)]


def check_reservable(day: date, section: str, slot: str, now: datetime) -> str:
    """予約できるなら "ok"、できないなら理由を返す。"""
    if section not in config.SECTIONS or slot not in slot_starts(section):
        return "bad_slot"
    if not section_in_period(section, day):
        return "out_of_period"
    if day not in (now.date(), now.date() + timedelta(days=1)):
        return "not_selectable_date"
    if slot_datetime(day, slot) <= now:
        return "past"
    return "ok"


def format_day(day: date) -> str:
    return f"{day.month}/{day.day}({config.WEEKDAYS[day.weekday()]})"
