import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import * as db from "../src/db.js";
import { withDb } from "./helpers.js";

const two = (database) => [db.addMember(database, "あかり"), db.addMember(database, "ゆうと")];

test("名簿に入れて並べる", () => withDb((d) => {
  two(d);
  assert.deepEqual(db.listMembers(d).map((m) => m.name), ["あかり", "ゆうと"]);
}));

test("同じ名前は入らない", () => withDb((d) => {
  db.addMember(d, "あかり");
  assert.throws(() => db.addMember(d, "あかり"), db.InvalidName);
}));

test("非表示にすると既定の一覧から消える", () => withDb((d) => {
  const id = db.addMember(d, "あかり");
  db.setMemberActive(d, id, false);
  assert.deepEqual(db.listMembers(d), []);
  assert.equal(db.listMembers(d, true).length, 1);
  assert.equal(db.countActiveMembers(d), 0);
}));

test("スキーマは何度当てても同じ", () => withDb((d) => {
  db.initSchema(d);
  db.initSchema(d);
}));

test("先に取られた枠は取れない", () => withDb((d) => {
  const [alice, bob] = two(d);
  assert.equal(db.reserve(d, "2026-08-20", "night", "shower", "19:00", alice), "ok");
  assert.equal(db.reserve(d, "2026-08-20", "night", "shower", "19:00", bob), "slot_taken");
}));

test("同じ区分で 2 枠目は取れない", () => withDb((d) => {
  const [alice] = two(d);
  db.reserve(d, "2026-08-20", "night", "shower", "19:00", alice);
  assert.equal(db.reserve(d, "2026-08-20", "night", "tub", "20:00", alice), "already_has");
}));

test("朝と夜は 1 枠ずつ持てる", () => withDb((d) => {
  const [alice] = two(d);
  db.reserve(d, "2026-08-20", "night", "shower", "19:00", alice);
  assert.equal(db.reserve(d, "2026-08-20", "morning", "shower", "06:00", alice), "ok");
}));

test("翌日は別に取れる", () => withDb((d) => {
  const [alice] = two(d);
  db.reserve(d, "2026-08-20", "night", "shower", "19:00", alice);
  assert.equal(db.reserve(d, "2026-08-21", "night", "shower", "19:00", alice), "ok");
}));

test("取り消せるのは自分の分だけ", () => withDb((d) => {
  const [alice, bob] = two(d);
  db.reserve(d, "2026-08-20", "night", "shower", "19:00", alice);
  const id = db.reservationsForDate(d, "2026-08-20").get(db.slotKey("shower", "19:00")).id;
  assert.equal(db.cancelReservation(d, id, bob), false);
  assert.equal(db.cancelReservation(d, id, alice), true);
  assert.equal(db.reservationsForDate(d, "2026-08-20").size, 0);
}));

test("取り消すと区分が空く", () => withDb((d) => {
  const [alice] = two(d);
  db.reserve(d, "2026-08-20", "night", "shower", "19:00", alice);
  const id = db.reservationsForDate(d, "2026-08-20").get(db.slotKey("shower", "19:00")).id;
  db.cancelReservation(d, id, alice);
  assert.equal(db.reserve(d, "2026-08-20", "night", "tub", "21:00", alice), "ok");
}));

test("量を合計する", () => withDb((d) => {
  const [alice, bob] = two(d);
  db.vote(d, "2026-08-20", "dinner", alice, "normal");
  db.vote(d, "2026-08-20", "dinner", bob, "large");
  assert.deepEqual(db.riceSummary(d, "2026-08-20", "dinner"), { people: 2, total: 1.5 });
  assert.deepEqual(db.riceSummary(d, "2026-08-20", "breakfast"), { people: 0, total: 0 });
}));

test("押し直すと量が差し替わる", () => withDb((d) => {
  const [alice] = two(d);
  db.vote(d, "2026-08-20", "dinner", alice, "normal");
  db.vote(d, "2026-08-20", "dinner", alice, "large");
  assert.deepEqual(db.riceSummary(d, "2026-08-20", "dinner"), { people: 1, total: 1 });
  assert.equal(db.memberVote(d, "2026-08-20", "dinner", alice), "large");
}));

test("知らない量は入らない", () => withDb((d) => {
  const [alice] = two(d);
  assert.throws(() => db.vote(d, "2026-08-20", "dinner", alice, "特盛"), RangeError);
}));

test("挙手していなければ null", () => withDb((d) => {
  const [alice] = two(d);
  assert.equal(db.memberVote(d, "2026-08-20", "dinner", alice), null);
}));

test("取り消しは 2 度目が false", () => withDb((d) => {
  const [alice] = two(d);
  db.vote(d, "2026-08-20", "dinner", alice, "large");
  assert.equal(db.unvote(d, "2026-08-20", "dinner", alice), true);
  assert.equal(db.unvote(d, "2026-08-20", "dinner", alice), false);
  assert.deepEqual(db.riceSummary(d, "2026-08-20", "dinner"), { people: 0, total: 0 });
}));

test("size 列が無い古い DB を開いても壊れない", () => withDb((_unused, dir) => {
  const old = new Database(path.join(dir, "old.db"));
  old.exec(`
    CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE rice_votes (id INTEGER PRIMARY KEY, date TEXT NOT NULL,
      meal TEXT NOT NULL, member_id INTEGER NOT NULL REFERENCES members(id),
      created_at TEXT NOT NULL, UNIQUE (date, meal, member_id));
  `);
  old.exec("INSERT INTO members (name, created_at) VALUES ('あかり', '')");
  old.prepare("INSERT INTO rice_votes (date, meal, member_id, created_at) VALUES (?, ?, 1, '')")
    .run("2026-08-20", "dinner");

  db.initSchema(old);
  assert.deepEqual(db.riceSummary(old, "2026-08-20", "dinner"), { people: 1, total: 0.5 });
  assert.equal(db.memberVote(old, "2026-08-20", "dinner", 1), "normal");
  old.close();
}));
