"""SQLite の接続とすべての問い合わせ。

先着順と 1 人 1 枠は一意制約が守る。アプリケーション側で空きを確認してから
書き込む形にすると、確認と書き込みの間に別の要求が割り込む。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

from .config import RICE_GO

SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS bath_reservations (
  id         INTEGER PRIMARY KEY,
  date       TEXT    NOT NULL,
  section    TEXT    NOT NULL CHECK (section IN ('morning', 'night')),
  room       TEXT    NOT NULL CHECK (room IN ('shower', 'tub')),
  slot       TEXT    NOT NULL,
  member_id  INTEGER NOT NULL REFERENCES members(id),
  created_at TEXT    NOT NULL,
  UNIQUE (date, room, slot),
  UNIQUE (date, section, member_id)
);

CREATE TABLE IF NOT EXISTS rice_votes (
  id         INTEGER PRIMARY KEY,
  date       TEXT    NOT NULL,
  meal       TEXT    NOT NULL CHECK (meal IN ('breakfast', 'dinner')),
  member_id  INTEGER NOT NULL REFERENCES members(id),
  size       TEXT    NOT NULL DEFAULT 'normal',
  created_at TEXT    NOT NULL,
  UNIQUE (date, meal, member_id)
);
"""


def connect(path: str | Path) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    # 既に動いている DB には列を後から足す。CREATE では追えないため。
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(rice_votes)")}
    if "size" not in columns:
        conn.execute(
            "ALTER TABLE rice_votes ADD COLUMN size TEXT NOT NULL DEFAULT 'normal'"
        )
    conn.commit()


def _stamp() -> str:
    return datetime.now().isoformat(timespec="seconds")


# --- 名簿 -----------------------------------------------------------------

def list_members(conn, include_hidden: bool = False) -> list[sqlite3.Row]:
    sql = "SELECT * FROM members"
    if not include_hidden:
        sql += " WHERE active = 1"
    sql += " ORDER BY id"
    return list(conn.execute(sql))


def get_member(conn, member_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()


def add_member(conn, name: str) -> int:
    name = name.strip()
    if not name:
        raise ValueError("名前が空です")
    try:
        cur = conn.execute(
            "INSERT INTO members (name, created_at) VALUES (?, ?)", (name, _stamp())
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        conn.rollback()
        raise ValueError("同じ名前がすでにあります") from exc
    return int(cur.lastrowid)


def set_member_active(conn, member_id: int, active: bool) -> None:
    conn.execute(
        "UPDATE members SET active = ? WHERE id = ?", (1 if active else 0, member_id)
    )
    conn.commit()


def count_active_members(conn) -> int:
    row = conn.execute("SELECT COUNT(*) AS n FROM members WHERE active = 1").fetchone()
    return int(row["n"])


# --- 風呂 -----------------------------------------------------------------

def reservations_for_date(conn, day: str) -> dict[tuple[str, str], sqlite3.Row]:
    rows = conn.execute(
        """
        SELECT r.id, r.room, r.slot, r.section, r.member_id, m.name
        FROM bath_reservations r JOIN members m ON m.id = r.member_id
        WHERE r.date = ?
        """,
        (day,),
    )
    return {(row["room"], row["slot"]): row for row in rows}


def member_reservation(conn, day: str, section: str, member_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM bath_reservations WHERE date = ? AND section = ? AND member_id = ?",
        (day, section, member_id),
    ).fetchone()


def reserve(conn, day: str, section: str, room: str, slot: str, member_id: int) -> str:
    """"ok" / "already_has" / "slot_taken" を返す。"""
    try:
        conn.execute(
            """
            INSERT INTO bath_reservations (date, section, room, slot, member_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (day, section, room, slot, member_id, _stamp()),
        )
        conn.commit()
        return "ok"
    except sqlite3.IntegrityError:
        conn.rollback()
        if member_reservation(conn, day, section, member_id) is not None:
            return "already_has"
        return "slot_taken"


def cancel_reservation(conn, reservation_id: int, member_id: int) -> bool:
    cur = conn.execute(
        "DELETE FROM bath_reservations WHERE id = ? AND member_id = ?",
        (reservation_id, member_id),
    )
    conn.commit()
    return cur.rowcount > 0


# --- 白米 -----------------------------------------------------------------

def rice_summary(conn, day: str, kind: str) -> tuple[int, float]:
    """(挙手した人数, 合計の合数) を返す。"""
    rows = conn.execute(
        "SELECT size, COUNT(*) AS n FROM rice_votes WHERE date = ? AND meal = ? GROUP BY size",
        (day, kind),
    ).fetchall()
    people = sum(int(row["n"]) for row in rows)
    total = sum(RICE_GO.get(row["size"], 0.0) * int(row["n"]) for row in rows)
    return people, total


def rice_by_size(conn, day: str, kind: str) -> dict[str, int]:
    """量ごとの人数。挙手が無い量も 0 で埋める。"""
    counts = {size: 0 for size in RICE_GO}
    rows = conn.execute(
        "SELECT size, COUNT(*) AS n FROM rice_votes WHERE date = ? AND meal = ? GROUP BY size",
        (day, kind),
    )
    for row in rows:
        if row["size"] in counts:
            counts[row["size"]] = int(row["n"])
    return counts


def member_vote(conn, day: str, kind: str, member_id: int) -> str | None:
    """その人が選んだ量。挙手していなければ None。"""
    row = conn.execute(
        "SELECT size FROM rice_votes WHERE date = ? AND meal = ? AND member_id = ?",
        (day, kind, member_id),
    ).fetchone()
    return row["size"] if row is not None else None


def vote(conn, day: str, kind: str, member_id: int, size: str) -> None:
    """挙手する。すでに挙手していれば量を差し替える。"""
    if size not in RICE_GO:
        raise ValueError(f"知らない量: {size}")
    conn.execute(
        """
        INSERT INTO rice_votes (date, meal, member_id, size, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (date, meal, member_id) DO UPDATE SET size = excluded.size
        """,
        (day, kind, member_id, size, _stamp()),
    )
    conn.commit()


def unvote(conn, day: str, kind: str, member_id: int) -> bool:
    cur = conn.execute(
        "DELETE FROM rice_votes WHERE date = ? AND meal = ? AND member_id = ?",
        (day, kind, member_id),
    )
    conn.commit()
    return cur.rowcount > 0
