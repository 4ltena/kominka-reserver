from app import db

from .conftest import at

NOON = at(8, 20, 12)


def body(response):
    return response.get_data(as_text=True)


def test_redirects_to_select_without_cookie(make_app):
    client = make_app(NOON).test_client()
    assert client.get("/bath").headers["Location"].endswith("/select")


def test_select_guides_to_members_when_empty(make_app):
    client = make_app(NOON).test_client()
    assert "名簿がまだ空" in body(client.get("/select"))


def test_reserve_shows_own_name_and_cancel(signed_in):
    _, client = signed_in(NOON)
    page = body(
        client.post(
            "/bath/reserve",
            data={"date": "2026-08-20", "section": "night", "room": "shower", "slot": "19:00"},
            follow_redirects=True,
        )
    )
    assert "あかり" in page
    assert "取消" in page


def test_taken_slot_reports_race(signed_in):
    app, client = signed_in(NOON)
    client.post(
        "/bath/reserve",
        data={"date": "2026-08-20", "section": "night", "room": "shower", "slot": "19:00"},
    )
    other = app.test_client()
    other.set_cookie("member_id", "2")
    page = body(
        other.post(
            "/bath/reserve",
            data={"date": "2026-08-20", "section": "night", "room": "shower", "slot": "19:00"},
            follow_redirects=True,
        )
    )
    assert "ちょうど埋まりました" in page


def test_second_slot_reports_held_one(signed_in):
    _, client = signed_in(NOON)
    client.post(
        "/bath/reserve",
        data={"date": "2026-08-20", "section": "night", "room": "shower", "slot": "19:00"},
    )
    page = body(
        client.post(
            "/bath/reserve",
            data={"date": "2026-08-20", "section": "night", "room": "tub", "slot": "20:00"},
            follow_redirects=True,
        )
    )
    assert "19:00" in page and "風呂を予約済み" in page


def test_started_slot_rejected(signed_in):
    _, client = signed_in(NOON)
    page = body(
        client.post(
            "/bath/reserve",
            data={"date": "2026-08-20", "section": "morning", "room": "shower", "slot": "06:00"},
            follow_redirects=True,
        )
    )
    assert "その枠は始まっています" in page


def test_other_reservation_has_no_cancel_button(signed_in):
    app, client = signed_in(NOON)
    with app.app_context():
        conn = db.connect(app.config["DB_PATH"])
        db.reserve(conn, "2026-08-20", "night", "shower", "19:00", 2)
        conn.close()
    page = body(client.get("/bath?date=2026-08-20"))
    assert "ゆうと" in page
    assert "取消" not in page


def test_out_of_period_day_shows_notice(signed_in):
    _, client = signed_in(at(8, 28, 5))
    assert "対象期間外" in body(client.get("/bath?date=2026-08-29"))


def test_meal_vote_flow(signed_in):
    _, client = signed_in(NOON)
    page = body(client.get("/meals"))
    assert "いる 0人 / 登録 2人" in page

    page = body(
        client.post(
            "/meals/vote",
            data={"date": "2026-08-20", "kind": "dinner"},
            follow_redirects=True,
        )
    )
    assert "いる ✓" in page
    assert "キャンセル" in page
    assert "いる 1人 / 登録 2人" in page

    page = body(
        client.post(
            "/meals/unvote",
            data={"date": "2026-08-20", "kind": "dinner"},
            follow_redirects=True,
        )
    )
    assert "いる 0人 / 登録 2人" in page


def test_closed_meal_rejects_vote(signed_in):
    app, client = signed_in(NOON)
    page = body(
        client.post(
            "/meals/vote",
            data={"date": "2026-08-20", "kind": "breakfast"},
            follow_redirects=True,
        )
    )
    assert "受付時間外です" in page
    with app.app_context():
        conn = db.connect(app.config["DB_PATH"])
        assert db.rice_count(conn, "2026-08-20", "breakfast") == 0
        conn.close()


def test_card_before_window_shows_start_time(signed_in):
    _, client = signed_in(NOON)
    page = body(client.get("/meals"))
    assert "8/20 18:00 から" in page


def test_members_add_hide_and_duplicate(signed_in):
    _, client = signed_in(NOON)
    page = body(client.post("/members", data={"name": "そら"}, follow_redirects=True))
    assert "そら" in page

    page = body(client.post("/members", data={"name": "そら"}, follow_redirects=True))
    assert "同じ名前がすでにあります" in page

    page = body(
        client.post("/members/hide", data={"member_id": "3", "active": "0"}, follow_redirects=True)
    )
    assert "戻す" in page
    assert "いる 0人 / 登録 2人" in body(client.get("/meals"))


def test_notify_test_without_settings(signed_in):
    _, client = signed_in(NOON)
    page = body(client.post("/members/notify-test", follow_redirects=True))
    assert "Discord の設定がありません" in page
