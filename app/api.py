"""Slack bot などの外部プログラム向けの JSON API。

画面と同じ規則で動く。締切や枠の判定は slots.py と meals.py に任せ、
先着順と 1 人 1 枠は db.py の一意制約が守る。ここは入出力の変換だけを担う。

失敗は HTTP の状態コードと機械可読な error 文字列で返す。画面側の日本語文言
とは分離してあるので、文面を変えても bot は壊れない。
"""

from __future__ import annotations

from datetime import date

from flask import Blueprint, g, jsonify, request
from werkzeug.exceptions import HTTPException

from . import clock, config, db, meals, slots
from .meals import Meal

bp = Blueprint("api", __name__, url_prefix="/api/v1")

# 拒否理由と HTTP 状態コードの対応。
STATUS = {
    "bad_request": 400,
    "bad_slot": 400,
    "bad_size": 400,
    "unknown_member": 404,
    "unknown_meal": 404,
    "unknown_reservation": 404,
    "not_in_period": 404,
    "not_selectable_date": 409,
    "slot_started": 409,
    "slot_taken": 409,
    "already_has": 409,
    "deadline_passed": 409,
}

# Flask が自分で投げる例外に付ける名前。経路や method を間違えたときに使う。
HTTP_ERRORS = {400: "bad_request", 404: "not_found", 405: "method_not_allowed"}

TRUE_WORDS = ("1", "true", "yes", "on")


def fail(code: str, **extra):
    return jsonify({"error": code, **extra}), STATUS.get(code, 400)


def register_errors(app) -> None:
    """API の経路では、Flask 既定の HTML ではなく JSON を返す。

    経路や method を間違えたときに HTML が返ると、呼ぶ側の JSON 解釈が例外で
    落ちる。原因が分からないまま止まるより、error を読める形にしておく。
    """
    prefix = bp.url_prefix + "/"

    @app.errorhandler(HTTPException)
    def _as_json(exc: HTTPException):
        if request.path != bp.url_prefix and not request.path.startswith(prefix):
            return exc
        body = {"error": HTTP_ERRORS.get(exc.code, "http_error")}
        if exc.description:
            body["detail"] = exc.description
        return jsonify(body), exc.code or 500


@bp.before_request
def _reject_broken_json():
    """JSON だと名乗っているのに解釈できない本体は、その旨を返す。"""
    if request.is_json and request.get_data() and request.get_json(silent=True) is None:
        return fail("bad_request", detail="JSON として解釈できない")
    return None


def _param(name: str):
    """JSON 本体、フォーム、クエリ文字列のどれで渡されても受ける。"""
    body = request.get_json(silent=True)
    if isinstance(body, dict) and name in body:
        return body[name]
    return request.form.get(name) or request.args.get(name)


def _flag(name: str) -> bool:
    return str(_param(name) or "").lower() in TRUE_WORDS


def _member_id():
    raw = _param("member_id")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _no_member_id():
    """member_id を受け取れなかった理由を分けて返す。"""
    raw = _param("member_id")
    detail = "member_id が要る" if raw is None else "member_id は整数で渡す"
    return fail("bad_request", detail=detail)


def _parse_date(raw: str) -> date | None:
    try:
        return date.fromisoformat(raw)
    except (TypeError, ValueError):
        return None


# --- 名簿 -----------------------------------------------------------------

@bp.get("/members")
def members():
    rows = db.list_members(g.conn)
    return jsonify(
        {
            "members": [{"id": r["id"], "name": r["name"]} for r in rows],
            "registered": len(rows),
        }
    )


# --- 食事 -----------------------------------------------------------------

def _meal_json(meal: Meal, now) -> dict:
    day = meal.day.isoformat()
    people, total = db.rice_summary(g.conn, day, meal.kind)
    return {
        "date": day,
        "meal": meal.kind,
        "state": meals.vote_state(meal, now),
        "deadline": meals.vote_deadline(meal).isoformat(),
        "go": float(total),
        "people": people,
        "registered": db.count_active_members(g.conn),
        "by_size": db.rice_by_size(g.conn, day, meal.kind),
    }


@bp.get("/meals")
def meal_list():
    """既定は画面と同じ直近 4 件。?all=true で期間内の全食事。"""
    now = clock.now()
    wanted = meals.all_meals() if _flag("all") else meals.visible_meals(now)
    return jsonify({"now": now.isoformat(), "meals": [_meal_json(m, now) for m in wanted]})


@bp.get("/meals/<day>/<kind>")
def meal_detail(day, kind):
    parsed = _parse_date(day)
    if parsed is None or kind not in config.MEALS or not meals.meal_in_period(kind, parsed):
        return fail("unknown_meal")
    return jsonify(_meal_json(Meal(parsed, kind), clock.now()))


@bp.post("/meals/<day>/<kind>/vote")
def meal_vote(day, kind):
    parsed = _parse_date(day)
    if parsed is None or kind not in config.MEALS or not meals.meal_in_period(kind, parsed):
        return fail("unknown_meal")

    member_id = _member_id()
    if member_id is None:
        return _no_member_id()
    if db.get_member(g.conn, member_id) is None:
        return fail("unknown_member")

    size = _param("size")
    if size not in config.RICE_SIZES:
        return fail("bad_size", allowed=list(config.RICE_SIZES))

    meal = Meal(parsed, kind)
    now = clock.now()
    if meals.vote_state(meal, now) != "open":
        return fail("deadline_passed", deadline=meals.vote_deadline(meal).isoformat())

    db.vote(g.conn, day, kind, member_id, size)
    return jsonify(_meal_json(meal, now))


@bp.delete("/meals/<day>/<kind>/vote")
def meal_unvote(day, kind):
    """挙手していなくても成功として返す。取り消しは何度呼んでも同じ。"""
    parsed = _parse_date(day)
    if parsed is None or kind not in config.MEALS or not meals.meal_in_period(kind, parsed):
        return fail("unknown_meal")

    member_id = _member_id()
    if member_id is None:
        return _no_member_id()

    meal = Meal(parsed, kind)
    now = clock.now()
    if meals.vote_state(meal, now) != "open":
        return fail("deadline_passed", deadline=meals.vote_deadline(meal).isoformat())

    db.unvote(g.conn, day, kind, member_id)
    return jsonify(_meal_json(meal, now))


# --- 風呂 -----------------------------------------------------------------

@bp.get("/bath/<day>")
def bath_day(day):
    parsed = _parse_date(day)
    if parsed is None:
        return fail("bad_request", detail="date は YYYY-MM-DD")

    now = clock.now()
    sections = slots.sections_for_date(parsed)
    if not sections:
        return fail("not_in_period")

    # 期間内でも、今日と明日以外はまだ受け付けない。空き表示だけを見て予約に
    # 進むと拒否されるため、枠ごとに可否を持たせる。
    selectable = parsed in slots.selectable_dates(now)
    reserved = db.reservations_for_date(g.conn, day)
    out = []
    for section in sections:
        rooms = []
        for room in config.ROOMS:
            entries = []
            for slot in slots.slot_starts(section, room):
                row = reserved.get((room, slot))
                starts_at = slots.slot_datetime(parsed, slot)
                if row is not None:
                    state, extra = "taken", {
                        "member_id": row["member_id"],
                        "name": row["name"],
                        "reservation_id": row["id"],
                    }
                else:
                    state = "past" if starts_at <= now else "free"
                    extra = {"member_id": None, "name": None, "reservation_id": None}
                entries.append({"slot": slot, "starts_at": starts_at.isoformat(),
                                "state": state, "reservable": selectable and state == "free",
                                **extra})
            rooms.append({"room": room, "minutes": config.ROOM_SLOT_MINUTES[room],
                          "slots": entries})
        out.append({"section": section, "rooms": rooms})

    return jsonify(
        {
            "date": day,
            "now": now.isoformat(),
            "selectable": selectable,
            "sections": out,
        }
    )


@bp.post("/bath/<day>/reserve")
def bath_reserve(day):
    parsed = _parse_date(day)
    if parsed is None:
        return fail("bad_request", detail="date は YYYY-MM-DD")

    member_id = _member_id()
    if member_id is None:
        return _no_member_id()
    if db.get_member(g.conn, member_id) is None:
        return fail("unknown_member")

    section = _param("section") or ""
    room = _param("room") or ""
    slot = _param("slot") or ""
    if room not in config.ROOMS:
        return fail("bad_slot", allowed=list(config.ROOMS))

    reason = slots.check_reservable(parsed, section, room, slot, clock.now())
    if reason == "past":
        return fail("slot_started")
    if reason == "out_of_period":
        return fail("not_in_period")
    if reason != "ok":
        return fail(reason)

    result = db.reserve(g.conn, day, section, room, slot, member_id)
    if result == "already_has":
        held = db.member_reservation(g.conn, day, section, member_id)
        return fail("already_has", held={"reservation_id": held["id"], "room": held["room"],
                                         "slot": held["slot"], "section": held["section"]})
    if result == "slot_taken":
        return fail("slot_taken")

    row = db.reservations_for_date(g.conn, day)[(room, slot)]
    return jsonify(
        {
            "reservation_id": row["id"],
            "date": day,
            "section": section,
            "room": room,
            "slot": slot,
            "starts_at": slots.slot_datetime(parsed, slot).isoformat(),
            "member_id": member_id,
            "name": row["name"],
        }
    ), 201


@bp.delete("/bath/reservations/<int:reservation_id>")
def bath_cancel(reservation_id):
    member_id = _member_id()
    if member_id is None:
        return _no_member_id()
    if not db.cancel_reservation(g.conn, reservation_id, member_id):
        return fail("unknown_reservation")
    return jsonify({"cancelled": reservation_id})
