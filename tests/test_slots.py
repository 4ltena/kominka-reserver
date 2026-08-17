from datetime import date

from app import config
from app.slots import (
    check_reservable,
    sections_for_date,
    selectable_dates,
    slot_starts,
)

from .conftest import at


def test_tub_morning_slots_are_20_minutes():
    assert slot_starts("morning", "tub") == (
        "06:00", "06:20", "06:40", "07:00", "07:20", "07:40",
    )


def test_shower_morning_slots_are_15_minutes():
    assert slot_starts("morning", "shower") == (
        "06:00", "06:15", "06:30", "06:45",
        "07:00", "07:15", "07:30", "07:45",
    )


def test_tub_night_slots_stop_at_23_00():
    starts = slot_starts("night", "tub")
    assert len(starts) == 13
    assert starts[0] == "19:00" and starts[-1] == "23:00"


def test_shower_night_slots_stop_at_23_00():
    starts = slot_starts("night", "shower")
    assert len(starts) == 17
    assert starts[0] == "19:00" and starts[-1] == "23:00"


def test_first_day_is_night_only():
    assert sections_for_date(date(2026, 8, 17)) == ("night",)


def test_last_day_is_morning_only():
    assert sections_for_date(date(2026, 8, 28)) == ("morning",)


def test_middle_day_has_both():
    assert sections_for_date(date(2026, 8, 20)) == ("morning", "night")


def test_outside_period_is_empty():
    assert sections_for_date(date(2026, 8, 29)) == ()
    assert sections_for_date(date(2026, 8, 16)) == ()


def test_started_slot_rejected():
    now = at(8, 20, 19, 5)
    assert check_reservable(date(2026, 8, 20), "night", "tub", "19:00", now) == "past"
    assert check_reservable(date(2026, 8, 20), "night", "tub", "19:20", now) == "ok"


def test_day_after_tomorrow_rejected():
    now = at(8, 20, 12)
    assert check_reservable(date(2026, 8, 22), "night", "tub", "19:00", now) == "not_selectable_date"


def test_out_of_period_rejected():
    now = at(8, 28, 5)
    assert check_reservable(date(2026, 8, 28), "night", "tub", "19:00", now) == "out_of_period"


def test_unknown_slot_rejected():
    now = at(8, 20, 12)
    assert check_reservable(date(2026, 8, 20), "night", "tub", "19:10", now) == "bad_slot"


def test_selectable_dates_stops_at_period_end():
    assert selectable_dates(at(8, 28, 5)) == [date(2026, 8, 28)]
    assert selectable_dates(at(8, 20, 5)) == [date(2026, 8, 20), date(2026, 8, 21)]


def test_period_constants_match_spec():
    assert config.PERIOD[("bath", "night")] == (date(2026, 8, 17), date(2026, 8, 27))
    assert config.PERIOD[("bath", "morning")] == (date(2026, 8, 18), date(2026, 8, 28))


def test_slot_length_differs_between_rooms():
    now = at(8, 20, 12)
    assert check_reservable(date(2026, 8, 20), "night", "shower", "19:15", now) == "ok"
    assert check_reservable(date(2026, 8, 20), "night", "tub", "19:15", now) == "bad_slot"
    assert check_reservable(date(2026, 8, 20), "night", "tub", "19:20", now) == "ok"
    assert check_reservable(date(2026, 8, 20), "night", "shower", "19:20", now) == "bad_slot"


def test_unknown_room_rejected():
    now = at(8, 20, 12)
    assert check_reservable(date(2026, 8, 20), "night", "sauna", "19:00", now) == "bad_slot"


def test_no_night_slot_starts_after_23_00():
    now = at(8, 20, 12)
    for room in ("shower", "tub"):
        assert check_reservable(date(2026, 8, 20), "night", room, "23:00", now) == "ok"
    assert check_reservable(date(2026, 8, 20), "night", "shower", "23:15", now) == "bad_slot"
    assert check_reservable(date(2026, 8, 20), "night", "tub", "23:20", now) == "bad_slot"
