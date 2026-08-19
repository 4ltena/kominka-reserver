/**
 * SQLite の接続とすべての問い合わせ。
 *
 * 先着順と 1 人 1 枠は一意制約が守る。アプリケーション側で空きを確認してから
 * 書き込む形にすると、確認と書き込みの間に別の要求が割り込む。
 *
 * better-sqlite3 は明示的な取引の外では 1 文ごとに確定するため、commit と
 * rollback を自分で呼ぶ必要はない。
 */

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { RICE_GO } from "./config.js";

export const SCHEMA = `
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
  created_at TEXT    NOT NULL
, UNIQUE (date, meal, member_id));
`;

/** 名前が空、または既にある。呼ぶ側が捌ける誤りとして分けておく。 */
export class InvalidName extends Error {}

export function connect(dbPath) {
  const target = String(dbPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target, { timeout: 5000 });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function initSchema(db) {
  db.exec(SCHEMA);
  // 既に動いている DB には列を後から足す。CREATE では追えないため。
  const columns = new Set(db.prepare("PRAGMA table_info(rice_votes)").all().map((r) => r.name));
  if (!columns.has("size")) {
    db.exec("ALTER TABLE rice_votes ADD COLUMN size TEXT NOT NULL DEFAULT 'normal'");
  }
}

/**
 * 制約に触れたか。Python の sqlite3.IntegrityError と同じ広さで、UNIQUE のほか
 * CHECK と外部キーも含む。どの制約かは呼ぶ側が問い合わせて決める。
 */
function isConstraint(error) {
  return typeof error?.code === "string" && error.code.startsWith("SQLITE_CONSTRAINT");
}

function stamp() {
  // 記録用。Python 版に合わせ、オフセットを付けない秒までの日本時刻。
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19);
}

// --- 名簿 -----------------------------------------------------------------

export function listMembers(db, includeHidden = false) {
  let sql = "SELECT * FROM members";
  if (!includeHidden) sql += " WHERE active = 1";
  sql += " ORDER BY id";
  return db.prepare(sql).all();
}

export function getMember(db, memberId) {
  return db.prepare("SELECT * FROM members WHERE id = ?").get(memberId) ?? null;
}

export function addMember(db, name) {
  const trimmed = String(name).trim();
  if (!trimmed) throw new InvalidName("名前が空です");
  try {
    const result = db
      .prepare("INSERT INTO members (name, created_at) VALUES (?, ?)")
      .run(trimmed, stamp());
    return Number(result.lastInsertRowid);
  } catch (error) {
    if (isConstraint(error)) throw new InvalidName("同じ名前がすでにあります");
    throw error;
  }
}

export function setMemberActive(db, memberId, active) {
  db.prepare("UPDATE members SET active = ? WHERE id = ?").run(active ? 1 : 0, memberId);
}

export function countActiveMembers(db) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM members WHERE active = 1").get().n);
}

// --- 風呂 -----------------------------------------------------------------

/** 浴室と時刻の組を鍵にする。浴室名に : は入らないので取り違えない。 */
export const slotKey = (room, slot) => `${room}:${slot}`;

export function reservationsForDate(db, day) {
  const rows = db
    .prepare(
      `SELECT r.id, r.room, r.slot, r.section, r.member_id, m.name
       FROM bath_reservations r JOIN members m ON m.id = r.member_id
       WHERE r.date = ?`,
    )
    .all(day);
  return new Map(rows.map((row) => [slotKey(row.room, row.slot), row]));
}

export function memberReservation(db, day, section, memberId) {
  return (
    db
      .prepare("SELECT * FROM bath_reservations WHERE date = ? AND section = ? AND member_id = ?")
      .get(day, section, memberId) ?? null
  );
}

/** "ok" / "already_has" / "slot_taken" を返す。 */
export function reserve(db, day, section, room, slot, memberId) {
  try {
    db
      .prepare(
        `INSERT INTO bath_reservations (date, section, room, slot, member_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(day, section, room, slot, memberId, stamp());
    return "ok";
  } catch (error) {
    if (!isConstraint(error)) throw error;
    return memberReservation(db, day, section, memberId) !== null ? "already_has" : "slot_taken";
  }
}

export function cancelReservation(db, reservationId, memberId) {
  const result = db
    .prepare("DELETE FROM bath_reservations WHERE id = ? AND member_id = ?")
    .run(reservationId, memberId);
  return result.changes > 0;
}

// --- 白米 -----------------------------------------------------------------

function riceCounts(db, day, kind) {
  return db
    .prepare("SELECT size, COUNT(*) AS n FROM rice_votes WHERE date = ? AND meal = ? GROUP BY size")
    .all(day, kind);
}

/** 挙手した人数と合計の合数。 */
export function riceSummary(db, day, kind) {
  let people = 0;
  let total = 0;
  for (const row of riceCounts(db, day, kind)) {
    people += Number(row.n);
    total += (RICE_GO[row.size] ?? 0) * Number(row.n);
  }
  return { people, total };
}

/** 量ごとの人数。挙手が無い量も 0 で埋める。 */
export function riceBySize(db, day, kind) {
  const counts = Object.fromEntries(Object.keys(RICE_GO).map((size) => [size, 0]));
  for (const row of riceCounts(db, day, kind)) {
    if (row.size in counts) counts[row.size] = Number(row.n);
  }
  return counts;
}

/** その人が選んだ量。挙手していなければ null。 */
export function memberVote(db, day, kind, memberId) {
  const row = db
    .prepare("SELECT size FROM rice_votes WHERE date = ? AND meal = ? AND member_id = ?")
    .get(day, kind, memberId);
  return row === undefined ? null : row.size;
}

/** 挙手する。すでに挙手していれば量を差し替える。 */
export function vote(db, day, kind, memberId, size) {
  if (!(size in RICE_GO)) throw new RangeError(`知らない量: ${size}`);
  db
    .prepare(
      `INSERT INTO rice_votes (date, meal, member_id, size, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (date, meal, member_id) DO UPDATE SET size = excluded.size`,
    )
    .run(day, kind, memberId, size, stamp());
}

export function unvote(db, day, kind, memberId) {
  const result = db
    .prepare("DELETE FROM rice_votes WHERE date = ? AND meal = ? AND member_id = ?")
    .run(day, kind, memberId);
  return result.changes > 0;
}
