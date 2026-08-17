"""風呂の枠と予約可否。現在時刻は引数で受け取り、データベースには触れない。"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from . import config


def slot_starts(section: str, room: str) -> tuple[str, ...]:
    """枠の長さは浴室ごとに違うため、開始時刻の並びも浴室ごとに変わる。"""
    start_hour, end_hour = config.SECTION_HOURS[section]
    step = config.ROOM_SLOT_MINUTES[room]

    override = config.SECTION_LAST_START.get(section)
    if override is not None:
        hour, minute = (int(part) for part in override.split(":"))
        limit = hour * 60 + minute
    else:
        # 指定が無ければ、枠が区分の終了時刻をはみ出さない最後の開始。
        limit = end_hour * 60 - step

    starts = []
    minute = start_hour * 60
    while minute <= limit:
        starts.append(f"{minute // 60:02d}:{minute % 60:02d}")
        minute += step
    return tuple(starts)


def section_in_period(section: str, day: date) -> bool:
    first, last = config.PERIOD[("bath", section)]
    return first <= day <= last


def sections_for_date(day: date) -> tuple[str, ...]:
    return tuple(s for s in config.SECTIONS if section_in_period(s, day))


def slot_datetime(day: date, slot: str) -> datetime:
    """"24:00" は翌日の 00:00 を指す。夜の最終枠がこの形になる。"""
    hour, minute = (int(part) for part in slot.split(":"))
    if hour >= 24:
        day += timedelta(days=hour // 24)
        hour %= 24
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=config.TZ)


def selectable_dates(now: datetime) -> list[date]:
    today = now.date()
    return [d for d in (today, today + timedelta(days=1)) if sections_for_date(d)]


def check_reservable(day: date, section: str, room: str, slot: str, now: datetime) -> str:
    """予約できるなら "ok"、できないなら理由を返す。"""
    if section not in config.SECTIONS or room not in config.ROOMS:
        return "bad_slot"
    if slot not in slot_starts(section, room):
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
