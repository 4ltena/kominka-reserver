from datetime import date

from app.meals import (
    Meal,
    all_meals,
    visible_meals,
    vote_state,
    vote_window,
)

from .conftest import at


def test_breakfast_window_is_previous_evening():
    assert vote_window(Meal(date(2026, 8, 19), "breakfast")) == (at(8, 18, 18), at(8, 18, 22))


def test_dinner_window_is_same_day():
    assert vote_window(Meal(date(2026, 8, 19), "dinner")) == (at(8, 19, 9), at(8, 19, 18))


def test_vote_state_boundaries():
    meal = Meal(date(2026, 8, 19), "dinner")
    assert vote_state(meal, at(8, 19, 8, 59)) == "before"
    assert vote_state(meal, at(8, 19, 9)) == "open"
    assert vote_state(meal, at(8, 19, 17, 59)) == "open"
    assert vote_state(meal, at(8, 19, 18)) == "closed"


def test_all_meals_bounds():
    meals = all_meals()
    assert meals[0] == Meal(date(2026, 8, 18), "dinner")
    assert Meal(date(2026, 8, 18), "breakfast") not in meals
    assert meals[-1] == Meal(date(2026, 8, 28), "breakfast")
    assert Meal(date(2026, 8, 28), "dinner") not in meals
    assert Meal(date(2026, 8, 17), "dinner") not in meals


def test_all_meals_are_ordered_by_deadline():
    deadlines = [vote_window(m)[1] for m in all_meals()]
    assert deadlines == sorted(deadlines)


def test_visible_meals_keep_one_closed():
    now = at(8, 20, 20)
    visible = visible_meals(now)
    assert len(visible) == 4
    assert vote_state(visible[0], now) == "closed"
    assert sum(1 for m in visible if vote_state(m, now) == "closed") == 1
