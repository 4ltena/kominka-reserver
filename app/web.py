"""Flask アプリとルーティング。

操作はすべて通常のフォーム送信で行い、書き込み後は転送して再送信を防ぐ。
JavaScript を切っていても予約と投票ができる。
"""

from __future__ import annotations

import secrets
from datetime import date
from pathlib import Path

from flask import Flask, flash, g, redirect, render_template, request, url_for

from . import api, clock, config, db, meals, slots
from .meals import Meal

COOKIE = "member_id"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30

MESSAGES = {
    "slot_taken": "この枠はちょうど埋まりました。",
    "past": "その枠は始まっています。",
    "out_of_period": "その日は予約できません。",
    "not_selectable_date": "その日は予約できません。",
    "bad_slot": "その枠は選べません。",
}


def format_go(total: float) -> str:
    """0.5 刻みなので、整数のときは小数点を落とす。"""
    return f"{total:g}"


def _secret_key(db_path: Path) -> str:
    path = Path(db_path).parent / "secret_key"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secrets.token_hex(32), encoding="utf-8")
    return path.read_text(encoding="utf-8").strip()


def create_app(config_path=None, db_path=None) -> Flask:
    app = Flask(__name__)
    db_path = Path(db_path) if db_path else config.DEFAULT_DB_PATH
    settings = config.load_settings(config_path)
    app.secret_key = _secret_key(db_path)
    app.config["DB_PATH"] = db_path
    app.config["SETTINGS"] = settings

    conn = db.connect(db_path)
    db.init_schema(conn)
    conn.close()

    # 名簿の名前をそのまま読めるようにする。JSON の規格上 UTF-8 でよい。
    app.json.ensure_ascii = False
    app.register_blueprint(api.bp)
    api.register_errors(app)

    @app.before_request
    def _open_db():
        g.conn = db.connect(app.config["DB_PATH"])

    @app.teardown_request
    def _close_db(exc):
        conn = g.pop("conn", None)
        if conn is not None:
            conn.close()

    @app.context_processor
    def _inject():
        return {"member": current_member(), "config": config}

    # --- 補助 -------------------------------------------------------------

    def current_member():
        raw = request.cookies.get(COOKIE)
        if not raw or not raw.isdigit():
            return None
        return db.get_member(g.conn, int(raw))

    def parse_date(raw: str | None) -> date | None:
        if not raw:
            return None
        try:
            return date.fromisoformat(raw)
        except ValueError:
            return None

    def default_bath_date(now) -> date:
        selectable = slots.selectable_dates(now)
        if not selectable:
            return slots.stay_date(now)
        for day in selectable:
            if slots.has_open_slot(day, now):
                return day
        return selectable[0]

    def bath_context(day: date, now, member):
        reserved = db.reservations_for_date(g.conn, day.isoformat())
        sections = []
        for section in slots.sections_for_date(day):
            columns = []
            for room in config.ROOMS:
                rows = []
                for slot in slots.slot_starts(section, room):
                    row = reserved.get((room, slot))
                    if row is None:
                        started = slots.slot_datetime(day, slot) <= now
                        rows.append(
                            {"slot": slot, "state": "past" if started else "free",
                             "name": None, "rid": None}
                        )
                    else:
                        mine = member is not None and row["member_id"] == member["id"]
                        rows.append(
                            {"slot": slot, "state": "mine" if mine else "taken",
                             "name": row["name"], "rid": row["id"]}
                        )
                columns.append(
                    {
                        "room": room,
                        "label": config.ROOM_LABELS[room],
                        "minutes": config.ROOM_SLOT_MINUTES[room],
                        "rows": rows,
                    }
                )
            sections.append(
                {"key": section, "label": config.SECTION_LABELS[section], "columns": columns}
            )
        tabs = [
            {"value": d.isoformat(), "label": slots.format_day(d), "current": d == day}
            for d in slots.selectable_dates(now)
        ]
        return {"day": day, "day_value": day.isoformat(), "sections": sections, "tabs": tabs}

    def meals_context(now, member):
        registered = db.count_active_members(g.conn)
        cards = []
        for meal in meals.visible_meals(now):
            day = meal.day.isoformat()
            closes = meals.vote_deadline(meal)
            people, total = db.rice_summary(g.conn, day, meal.kind)
            cards.append(
                {
                    "day": day,
                    "kind": meal.kind,
                    "title": meals.format_meal(meal),
                    "state": meals.vote_state(meal, now),
                    "closes": f"{closes.month}/{closes.day} {closes:%H:%M}",
                    "wanted": people,
                    "total": format_go(total),
                    "registered": registered,
                    "voted": member is not None
                    and db.member_vote(g.conn, day, meal.kind, member["id"]),
                }
            )
        return {"cards": cards}

    # --- 名前の選択 -------------------------------------------------------

    @app.get("/")
    def index():
        return redirect(url_for("bath"))

    @app.get("/select")
    def select():
        return render_template("select.html", members=db.list_members(g.conn))

    @app.post("/select")
    def select_post():
        member_id = request.form.get("member_id", "")
        if not member_id.isdigit() or db.get_member(g.conn, int(member_id)) is None:
            flash("名前を選んでください。")
            return redirect(url_for("select"))
        response = redirect(url_for("bath"))
        response.set_cookie(COOKIE, member_id, max_age=COOKIE_MAX_AGE, samesite="Lax")
        return response

    # --- 風呂 -------------------------------------------------------------

    @app.get("/bath")
    def bath():
        member = current_member()
        if member is None:
            return redirect(url_for("select"))
        now = clock.now()
        day = parse_date(request.args.get("date")) or default_bath_date(now)
        return render_template("bath.html", **bath_context(day, now, member))

    @app.get("/fragment/bath")
    def bath_fragment():
        member = current_member()
        now = clock.now()
        day = parse_date(request.args.get("date")) or default_bath_date(now)
        return render_template("_bath_table.html", **bath_context(day, now, member))

    @app.post("/bath/reserve")
    def bath_reserve():
        member = current_member()
        if member is None:
            return redirect(url_for("select"))
        now = clock.now()
        day = parse_date(request.form.get("date"))
        section = request.form.get("section", "")
        room = request.form.get("room", "")
        slot = request.form.get("slot", "")
        if day is None or room not in config.ROOMS:
            flash(MESSAGES["bad_slot"])
            return redirect(url_for("bath"))
        reason = slots.check_reservable(day, section, room, slot, now)
        if reason != "ok":
            flash(MESSAGES[reason])
            return redirect(url_for("bath", date=day.isoformat()))
        result = db.reserve(g.conn, day.isoformat(), section, room, slot, member["id"])
        if result == "already_has":
            held = db.member_reservation(g.conn, day.isoformat(), section, member["id"])
            flash(
                f"{config.SECTION_LABELS[section]}の枠は {held['slot']} の"
                f"{config.ROOM_LABELS[held['room']]}を予約済みです。"
                "取り消してから選んでください。"
            )
        elif result == "slot_taken":
            flash(MESSAGES["slot_taken"])
        return redirect(url_for("bath", date=day.isoformat()))

    @app.post("/bath/cancel")
    def bath_cancel():
        member = current_member()
        if member is None:
            return redirect(url_for("select"))
        raw = request.form.get("reservation_id", "")
        day = parse_date(request.form.get("date"))
        if raw.isdigit() and not db.cancel_reservation(g.conn, int(raw), member["id"]):
            flash("他の人の予約は取り消せません。")
        target = day.isoformat() if day else None
        return redirect(url_for("bath", date=target))

    # --- ごはん -----------------------------------------------------------

    @app.get("/meals")
    def meals_page():
        member = current_member()
        if member is None:
            return redirect(url_for("select"))
        return render_template("meals.html", **meals_context(clock.now(), member))

    @app.get("/fragment/meals")
    def meals_fragment():
        member = current_member()
        return render_template("_meal_cards.html", **meals_context(clock.now(), member))

    def _meal_from_form():
        day = parse_date(request.form.get("date"))
        kind = request.form.get("kind", "")
        if day is None or kind not in config.MEALS or not meals.meal_in_period(kind, day):
            return None
        return Meal(day, kind)

    @app.post("/meals/vote")
    def meals_vote():
        member = current_member()
        if member is None:
            return redirect(url_for("select"))
        meal = _meal_from_form()
        size = request.form.get("size", "")
        if size not in config.RICE_SIZES:
            flash(MESSAGES["bad_slot"])
        elif meal is None or meals.vote_state(meal, clock.now()) != "open":
            flash("受付時間外です。")
        else:
            db.vote(g.conn, meal.day.isoformat(), meal.kind, member["id"], size)
        return redirect(url_for("meals_page"))

    @app.post("/meals/unvote")
    def meals_unvote():
        member = current_member()
        if member is None:
            return redirect(url_for("select"))
        meal = _meal_from_form()
        if meal is None or meals.vote_state(meal, clock.now()) != "open":
            flash("受付時間外です。")
        else:
            db.unvote(g.conn, meal.day.isoformat(), meal.kind, member["id"])
        return redirect(url_for("meals_page"))

    # --- 名簿 -------------------------------------------------------------

    @app.get("/members")
    def members():
        return render_template("members.html", members=db.list_members(g.conn))

    app.jinja_env.globals["current_member"] = current_member
    return app
