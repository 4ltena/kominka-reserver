from app import db

from .conftest import at

NOON = at(8, 20, 12)


def api(make_app, now=NOON):
    """名簿に 2 人入れたアプリと、その client を返す。"""
    app = make_app(now)
    with app.app_context():
        conn = db.connect(app.config["DB_PATH"])
        db.add_member(conn, "あかり")
        db.add_member(conn, "ゆうと")
        conn.close()
    return app, app.test_client()


# --- 名簿 -----------------------------------------------------------------

def test_members(make_app):
    _, client = api(make_app)
    body = client.get("/api/v1/members").get_json()
    assert body["registered"] == 2
    assert body["members"][0] == {"id": 1, "name": "あかり"}


# --- 食事 -----------------------------------------------------------------

def test_meal_list_matches_the_screen(make_app):
    _, client = api(make_app)
    body = client.get("/api/v1/meals").get_json()
    assert len(body["meals"]) == 4
    first = body["meals"][0]
    assert set(first) == {
        "date", "meal", "state", "deadline", "go", "people", "registered", "by_size",
    }
    assert first["deadline"].endswith("+09:00")


def test_meal_list_all(make_app):
    _, client = api(make_app)
    assert len(client.get("/api/v1/meals?all=true").get_json()["meals"]) == 20


def test_vote_and_totals(make_app):
    _, client = api(make_app)
    url = "/api/v1/meals/2026-08-20/dinner/vote"

    body = client.post(url, json={"member_id": 1, "size": "large"}).get_json()
    assert (body["go"], body["people"]) == (1.0, 1)
    assert body["by_size"] == {"normal": 0, "large": 1}

    body = client.post(url, json={"member_id": 2, "size": "normal"}).get_json()
    assert (body["go"], body["people"]) == (1.5, 2)

    # もう一度押すと量が差し替わり、人数は増えない。
    body = client.post(url, json={"member_id": 1, "size": "normal"}).get_json()
    assert (body["go"], body["people"]) == (1.0, 2)


def test_unvote(make_app):
    _, client = api(make_app)
    url = "/api/v1/meals/2026-08-20/dinner/vote"
    client.post(url, json={"member_id": 1, "size": "large"})
    body = client.delete(url, json={"member_id": 1}).get_json()
    assert (body["go"], body["people"]) == (0, 0)


def test_unvote_accepts_a_query_parameter(make_app):
    """DELETE に本体を付けられない client のため。"""
    _, client = api(make_app)
    url = "/api/v1/meals/2026-08-20/dinner/vote"
    client.post(url, json={"member_id": 1, "size": "large"})
    assert client.delete(url + "?member_id=1").status_code == 200


def test_vote_after_deadline(make_app):
    _, client = api(make_app)
    response = client.post(
        "/api/v1/meals/2026-08-20/breakfast/vote", json={"member_id": 1, "size": "normal"}
    )
    assert response.status_code == 409
    assert response.get_json()["error"] == "deadline_passed"


def test_vote_errors(make_app):
    _, client = api(make_app)
    url = "/api/v1/meals/2026-08-20/dinner/vote"
    assert client.post(url, json={"member_id": 99, "size": "normal"}).get_json()["error"] == "unknown_member"
    assert client.post(url, json={"member_id": 1, "size": "特盛"}).get_json()["error"] == "bad_size"
    assert client.post(url, json={"size": "normal"}).get_json()["error"] == "bad_request"
    out = client.post("/api/v1/meals/2026-08-29/dinner/vote", json={"member_id": 1, "size": "normal"})
    assert out.status_code == 404 and out.get_json()["error"] == "unknown_meal"


# --- 風呂 -----------------------------------------------------------------

def test_bath_day(make_app):
    _, client = api(make_app)
    body = client.get("/api/v1/bath/2026-08-20").get_json()
    assert body["selectable"] is True
    assert [s["section"] for s in body["sections"]] == ["morning", "night"]

    night = next(s for s in body["sections"] if s["section"] == "night")
    shower = next(r for r in night["rooms"] if r["room"] == "shower")
    assert shower["minutes"] == 15
    assert shower["slots"][-1]["slot"] == "25:00"
    # 25:00 は翌日を指す。
    assert shower["slots"][-1]["starts_at"].startswith("2026-08-21T01:00")
    # 正午なので朝は済んでいる。
    morning = next(s for s in body["sections"] if s["section"] == "morning")
    assert morning["rooms"][0]["slots"][0]["state"] == "past"


def test_bath_out_of_period(make_app):
    _, client = api(make_app)
    assert client.get("/api/v1/bath/2026-08-29").get_json()["error"] == "not_in_period"


def test_reserve_and_cancel(make_app):
    _, client = api(make_app)
    payload = {"member_id": 1, "section": "night", "room": "shower", "slot": "19:00"}
    response = client.post("/api/v1/bath/2026-08-20/reserve", json=payload)
    assert response.status_code == 201
    body = response.get_json()
    assert body["name"] == "あかり"
    assert body["starts_at"].startswith("2026-08-20T19:00")

    taken = client.post("/api/v1/bath/2026-08-20/reserve", json={**payload, "member_id": 2})
    assert taken.status_code == 409 and taken.get_json()["error"] == "slot_taken"

    second = client.post(
        "/api/v1/bath/2026-08-20/reserve",
        json={"member_id": 1, "section": "night", "room": "tub", "slot": "20:00"},
    )
    assert second.get_json()["error"] == "already_has"
    assert second.get_json()["held"]["slot"] == "19:00"

    rid = body["reservation_id"]
    assert client.delete(f"/api/v1/bath/reservations/{rid}", json={"member_id": 2}).status_code == 404
    assert client.delete(f"/api/v1/bath/reservations/{rid}", json={"member_id": 1}).status_code == 200


def test_reserve_rejects_started_and_far_dates(make_app):
    _, client = api(make_app)
    started = client.post(
        "/api/v1/bath/2026-08-20/reserve",
        json={"member_id": 1, "section": "morning", "room": "shower", "slot": "06:00"},
    )
    assert started.get_json()["error"] == "slot_started"

    far = client.post(
        "/api/v1/bath/2026-08-22/reserve",
        json={"member_id": 1, "section": "night", "room": "shower", "slot": "19:00"},
    )
    assert far.get_json()["error"] == "not_selectable_date"

    bad = client.post(
        "/api/v1/bath/2026-08-20/reserve",
        json={"member_id": 1, "section": "night", "room": "sauna", "slot": "19:00"},
    )
    assert bad.get_json()["error"] == "bad_slot"


def test_api_and_screen_share_state(make_app):
    """API で入れた投票が画面に出る。"""
    _, client = api(make_app)
    client.post("/api/v1/meals/2026-08-20/dinner/vote", json={"member_id": 1, "size": "large"})
    client.set_cookie("member_id", "1")
    page = client.get("/meals").get_data(as_text=True)
    assert "1合" in page and "いる 1人 / 登録 2人" in page


# --- 経路の間違い ---------------------------------------------------------

def test_wrong_path_and_method_stay_json(make_app):
    """HTML が返ると呼ぶ側の JSON 解釈が落ちる。"""
    _, client = api(make_app)
    for response, code in (
        (client.get("/api/v1/nope"), "not_found"),
        (client.get("/api/v1/members/"), "not_found"),
        (client.post("/api/v1/members"), "method_not_allowed"),
        (client.delete("/api/v1/bath/reservations/abc"), "not_found"),
    ):
        assert response.is_json, response.get_data(as_text=True)[:60]
        assert response.get_json()["error"] == code


def test_screen_keeps_html_errors(make_app):
    """API 以外は今までどおり。"""
    _, client = api(make_app)
    assert not client.get("/nope").is_json


def test_broken_json_says_so(make_app):
    _, client = api(make_app)
    response = client.post(
        "/api/v1/meals/2026-08-20/dinner/vote", data="{oops", content_type="application/json"
    )
    assert response.status_code == 400
    assert "JSON" in response.get_json()["detail"]


def test_member_id_that_is_not_a_number(make_app):
    _, client = api(make_app)
    body = client.post(
        "/api/v1/meals/2026-08-20/dinner/vote", json={"member_id": "abc", "size": "normal"}
    ).get_json()
    assert body["error"] == "bad_request" and "整数" in body["detail"]


# --- 受け取り方の揺れ -----------------------------------------------------

def test_all_accepts_the_usual_spellings(make_app):
    _, client = api(make_app)
    for raw in ("true", "1", "yes", "TRUE"):
        assert len(client.get(f"/api/v1/meals?all={raw}").get_json()["meals"]) == 20


def test_names_are_not_escaped(make_app):
    _, client = api(make_app)
    assert "あかり" in client.get("/api/v1/members").get_data(as_text=True)


def test_go_is_always_a_float(make_app):
    _, client = api(make_app)
    assert isinstance(client.get("/api/v1/meals/2026-08-27/dinner").get_json()["go"], float)


# --- 予約できるかを枠ごとに示す -------------------------------------------

def test_reservable_marks_dates_that_are_too_far(make_app):
    """期間内でも今日と明日以外は受け付けない。state だけ見ると取り違える。"""
    _, client = api(make_app)
    far = client.get("/api/v1/bath/2026-08-22").get_json()
    assert far["selectable"] is False
    slot = far["sections"][0]["rooms"][0]["slots"][0]
    assert slot["state"] == "free" and slot["reservable"] is False

    near = client.get("/api/v1/bath/2026-08-20").get_json()
    night = next(s for s in near["sections"] if s["section"] == "night")
    assert night["rooms"][0]["slots"][0]["reservable"] is True
    morning = next(s for s in near["sections"] if s["section"] == "morning")
    assert morning["rooms"][0]["slots"][0]["reservable"] is False  # 正午なので済んでいる
