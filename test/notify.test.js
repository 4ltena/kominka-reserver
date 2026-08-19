import assert from "node:assert/strict";
import { test } from "node:test";

import { ROOM_LABELS, due, message } from "../bot/notify.js";

// GET /api/v1/bath/2026-08-20 の応答から、判定に要る部分だけを写したもの。
const TAKEN = {
  slot: "19:00",
  starts_at: "2026-08-20T19:00:00+09:00",
  state: "taken",
  reservable: false,
  member_id: 1,
  name: "あかり",
  reservation_id: 7,
};
const FREE = { ...TAKEN, slot: "19:20", starts_at: "2026-08-20T19:20:00+09:00", state: "free", member_id: null, name: null, reservation_id: null };

const day = (...slots) => [
  { date: "2026-08-20", sections: [{ section: "night", rooms: [{ room: "tub", minutes: 20, slots }] }] },
];

const START = Date.parse(TAKEN.starts_at);
/** 開始の n 分前の瞬間。日時を手で書くと境界を直すたびに壊れるため計算で作る。 */
const before = (minutes) => START - minutes * 60 * 1000;
const KEY = "2026-08-20|tub|19:00|1";

test("開始 4 分前の予約は選ばれる", () => {
  const found = due(day(TAKEN), before(4), new Set());
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { key: KEY, name: "あかり", room: "tub", slot: "19:00" });
});

test("開始 5 分ちょうど前は選ばれる", () => {
  assert.equal(due(day(TAKEN), before(5), new Set()).length, 1);
});

test("開始 6 分前はまだ選ばれない", () => {
  assert.equal(due(day(TAKEN), before(6), new Set()).length, 0);
});

test("開始時刻ちょうどと開始後は選ばれない", () => {
  // 予約済みの枠は開始後も state が taken のままなので、ここを弾かないと
  // 夜に起動した瞬間その日の終わった枠へ通知が飛ぶ。
  assert.equal(due(day(TAKEN), START, new Set()).length, 0);
  assert.equal(due(day(TAKEN), before(-1), new Set()).length, 0);
});

test("空き枠は選ばれない", () => {
  assert.equal(due(day(FREE), Date.parse(FREE.starts_at) - 60 * 1000, new Set()).length, 0);
});

test("送信済みの鍵は選ばれない", () => {
  assert.equal(due(day(TAKEN), before(4), new Set([KEY])).length, 0);
});

test("鍵は日付・浴室・時刻・人の 4 つ組。reservation_id は使わない", () => {
  // 取り消しで空いた id を SQLite が再利用しても、別人なら別の鍵になる。
  const other = { ...TAKEN, member_id: 2, name: "たかし", reservation_id: 7 };
  const found = due(day(other), before(4), new Set([KEY]));
  assert.equal(found.length, 1);
  assert.equal(found[0].key, "2026-08-20|tub|19:00|2");
});

test("対応表にあればメンション、無ければ平文", () => {
  const entry = { key: KEY, name: "あかり", room: "tub", slot: "19:00" };
  assert.equal(message(entry, { あかり: "U01ABCD2EF" }), "<@U01ABCD2EF> あと5分で 風呂（浴槽付き） 19:00 です");
  assert.equal(message(entry, {}), "あかりさん あと5分で 風呂（浴槽付き） 19:00 です");
});

test("浴槽の有無を取り違えない", () => {
  const at = (room) => ({ key: "k", name: "あかり", room, slot: "19:00" });
  assert.match(message(at("tub"), {}), /風呂（浴槽付き） 19:00/);
  assert.match(message(at("shower"), {}), /あかりさん あと5分で 風呂 19:00 です/);
});

test("浴室の名前は src/config.js と食い違っていない", async () => {
  // bot は Pi に src/ が無いため書き写している。写し間違いと、あとからの変更を拾う。
  const { ROOM_LABELS: app } = await import("../src/config.js");
  assert.deepEqual(ROOM_LABELS, app);
});
