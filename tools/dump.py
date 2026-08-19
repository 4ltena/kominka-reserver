"""Python 版の純関数の出力を、そのまま比較できる形で吐く。tools/dump.mjs と対にする。"""

import hashlib
import sys
from datetime import date, datetime, timedelta

from app import config, meals, slots

TZ = config.TZ
FIRST = date(2026, 8, 16)
LAST = date(2026, 8, 29)


def days():
    day = FIRST
    while day <= LAST:
        yield day
        day += timedelta(days=1)


def grid(step_minutes):
    now = datetime(2026, 8, 16, 0, 0, tzinfo=TZ)
    end = datetime(2026, 8, 29, 0, 0, tzinfo=TZ)
    while now <= end:
        yield now
        now += timedelta(minutes=step_minutes)


def emit(out, label, value):
    out.write(f"{label}\t{value}\n")


def main():
    out = sys.stdout

    for section in config.SECTIONS:
        for room in config.ROOMS:
            emit(out, f"slot_starts {section} {room}", ",".join(slots.slot_starts(section, room)))

    for day in days():
        emit(out, f"sections_for_date {day}", ",".join(slots.sections_for_date(day)))
        emit(out, f"format_day {day}", slots.format_day(day))

    for meal in meals.all_meals():
        emit(out, f"meal {meal.day} {meal.kind}", meals.format_meal(meal))
        emit(out, f"deadline {meal.day} {meal.kind}", meals.vote_deadline(meal).isoformat())

    for day in days():
        for section in config.SECTIONS:
            for room in config.ROOMS:
                for slot in slots.slot_starts(section, room):
                    when = slots.slot_datetime(day, slot)
                    emit(out, f"slot_datetime {day} {slot}", when.isoformat())

    # 1 分刻み。滞在日の境目を隅々まで見る。
    for now in grid(1):
        stay = slots.stay_date(now)
        selectable = ",".join(str(d) for d in slots.selectable_dates(now))
        emit(out, f"stay {now.isoformat()}", f"{stay}|{selectable}")

    # 30 分刻み。全ての日・区分・浴室・枠についての可否をまとめて digest にする。
    for now in grid(30):
        parts = []
        for day in days():
            for section in config.SECTIONS:
                for room in config.ROOMS:
                    for slot in slots.slot_starts(section, room):
                        parts.append(slots.check_reservable(day, section, room, slot, now))
            parts.append("1" if slots.has_open_slot(day, now) else "0")
        for meal in meals.all_meals():
            parts.append(meals.vote_state(meal, now))
        parts.append(",".join(f"{m.day}{m.kind}" for m in meals.visible_meals(now)))
        joined = "|".join(parts)
        emit(out, f"digest {now.isoformat()}", hashlib.sha1(joined.encode()).hexdigest())


main()
