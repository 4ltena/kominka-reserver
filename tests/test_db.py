import pytest

from app import db


def test_add_and_list_members(conn):
    db.add_member(conn, "あかり")
    db.add_member(conn, "ゆうと")
    assert [m["name"] for m in db.list_members(conn)] == ["あかり", "ゆうと"]


def test_duplicate_name_rejected(conn):
    db.add_member(conn, "あかり")
    with pytest.raises(ValueError):
        db.add_member(conn, "あかり")


def test_hidden_member_drops_out_of_default_list(conn):
    member_id = db.add_member(conn, "あかり")
    db.set_member_active(conn, member_id, False)
    assert db.list_members(conn) == []
    assert len(db.list_members(conn, include_hidden=True)) == 1
    assert db.count_active_members(conn) == 0


def test_init_schema_is_repeatable(conn):
    db.init_schema(conn)
    db.init_schema(conn)


def test_reserve_then_slot_is_taken(conn, alice, bob):
    assert db.reserve(conn, "2026-08-20", "night", "shower", "19:00", alice) == "ok"
    assert db.reserve(conn, "2026-08-20", "night", "shower", "19:00", bob) == "slot_taken"


def test_second_slot_in_same_section_rejected(conn, alice):
    db.reserve(conn, "2026-08-20", "night", "shower", "19:00", alice)
    assert db.reserve(conn, "2026-08-20", "night", "tub", "20:00", alice) == "already_has"


def test_morning_and_night_both_allowed(conn, alice):
    db.reserve(conn, "2026-08-20", "night", "shower", "19:00", alice)
    assert db.reserve(conn, "2026-08-20", "morning", "shower", "06:00", alice) == "ok"


def test_next_day_allowed(conn, alice):
    db.reserve(conn, "2026-08-20", "night", "shower", "19:00", alice)
    assert db.reserve(conn, "2026-08-21", "night", "shower", "19:00", alice) == "ok"


def test_cancel_only_own(conn, alice, bob):
    db.reserve(conn, "2026-08-20", "night", "shower", "19:00", alice)
    rid = db.reservations_for_date(conn, "2026-08-20")[("shower", "19:00")]["id"]
    assert db.cancel_reservation(conn, rid, bob) is False
    assert db.cancel_reservation(conn, rid, alice) is True
    assert db.reservations_for_date(conn, "2026-08-20") == {}


def test_cancel_frees_the_section(conn, alice):
    db.reserve(conn, "2026-08-20", "night", "shower", "19:00", alice)
    rid = db.reservations_for_date(conn, "2026-08-20")[("shower", "19:00")]["id"]
    db.cancel_reservation(conn, rid, alice)
    assert db.reserve(conn, "2026-08-20", "night", "tub", "21:00", alice) == "ok"


def test_rice_amounts_are_summed(conn, alice, bob):
    db.vote(conn, "2026-08-20", "dinner", alice, "normal")
    db.vote(conn, "2026-08-20", "dinner", bob, "large")
    assert db.rice_summary(conn, "2026-08-20", "dinner") == (2, 1.5)
    assert db.rice_summary(conn, "2026-08-20", "breakfast") == (0, 0.0)


def test_second_vote_replaces_the_size(conn, alice):
    db.vote(conn, "2026-08-20", "dinner", alice, "normal")
    db.vote(conn, "2026-08-20", "dinner", alice, "large")
    assert db.rice_summary(conn, "2026-08-20", "dinner") == (1, 1.0)
    assert db.member_vote(conn, "2026-08-20", "dinner", alice) == "large"


def test_unknown_size_rejected(conn, alice):
    with pytest.raises(ValueError):
        db.vote(conn, "2026-08-20", "dinner", alice, "特盛")


def test_member_vote_is_none_when_absent(conn, alice):
    assert db.member_vote(conn, "2026-08-20", "dinner", alice) is None


def test_unvote(conn, alice):
    db.vote(conn, "2026-08-20", "dinner", alice, "large")
    assert db.unvote(conn, "2026-08-20", "dinner", alice) is True
    assert db.unvote(conn, "2026-08-20", "dinner", alice) is False
    assert db.rice_summary(conn, "2026-08-20", "dinner") == (0, 0.0)


def test_size_column_is_added_to_an_existing_database(tmp_path):
    """size 列が無い古い DB を開いても壊れない。"""
    path = tmp_path / "old.db"
    old = db.connect(path)
    old.executescript("""
        CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
          active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
        CREATE TABLE rice_votes (id INTEGER PRIMARY KEY, date TEXT NOT NULL,
          meal TEXT NOT NULL, member_id INTEGER NOT NULL REFERENCES members(id),
          created_at TEXT NOT NULL, UNIQUE (date, meal, member_id));
    """)
    old.execute("INSERT INTO members (name, created_at) VALUES ('あかり', '')")
    old.execute(
        "INSERT INTO rice_votes (date, meal, member_id, created_at) VALUES (?, ?, 1, '')",
        ("2026-08-20", "dinner"),
    )
    old.commit()

    db.init_schema(old)
    assert db.rice_summary(old, "2026-08-20", "dinner") == (1, 0.5)
    assert db.member_vote(old, "2026-08-20", "dinner", 1) == "normal"
    old.close()
