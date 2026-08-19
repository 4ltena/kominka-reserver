import assert from "node:assert/strict";
import { test } from "node:test";

import * as config from "../src/config.js";
import * as jst from "../src/jst.js";
import {
  checkReservable,
  sectionsForDate,
  selectableDates,
  slotInstant,
  slotStarts,
  stayDate,
} from "../src/slots.js";
import { at } from "./helpers.js";

test("浴槽付きの朝は 20 分刻み", () => {
  assert.deepEqual(slotStarts("morning", "tub"),
    ["06:00", "06:20", "06:40", "07:00", "07:20", "07:40"]);
});

test("浴槽なしの朝は 15 分刻み", () => {
  assert.deepEqual(slotStarts("morning", "shower"),
    ["06:00", "06:15", "06:30", "06:45", "07:00", "07:15", "07:30", "07:45"]);
});

test("浴槽付きの夜は 25:00 まで 19 枠", () => {
  const starts = slotStarts("night", "tub");
  assert.equal(starts.length, 19);
  assert.equal(starts[0], "19:00");
  assert.equal(starts.at(-1), "25:00");
});

test("浴槽なしの夜は 25:00 まで 25 枠", () => {
  const starts = slotStarts("night", "shower");
  assert.equal(starts.length, 25);
  assert.equal(starts[0], "19:00");
  assert.equal(starts.at(-1), "25:00");
});

test("初日は夜だけ", () => assert.deepEqual(sectionsForDate("2026-08-17"), ["night"]));
test("最終日は朝だけ", () => assert.deepEqual(sectionsForDate("2026-08-28"), ["morning"]));
test("途中の日は両方", () => assert.deepEqual(sectionsForDate("2026-08-20"), ["morning", "night"]));

test("期間の外は空", () => {
  assert.deepEqual(sectionsForDate("2026-08-29"), []);
  assert.deepEqual(sectionsForDate("2026-08-16"), []);
});

test("始まった枠は取れない", () => {
  const now = at(8, 20, 19, 5);
  assert.equal(checkReservable("2026-08-20", "night", "tub", "19:00", now), "past");
  assert.equal(checkReservable("2026-08-20", "night", "tub", "19:20", now), "ok");
});

test("明後日は取れない", () => {
  assert.equal(checkReservable("2026-08-22", "night", "tub", "19:00", at(8, 20, 12)),
    "not_selectable_date");
});

test("期間外の区分は取れない", () => {
  assert.equal(checkReservable("2026-08-28", "night", "tub", "19:00", at(8, 28, 6)),
    "out_of_period");
});

test("刻みに乗らない時刻は取れない", () => {
  assert.equal(checkReservable("2026-08-20", "night", "tub", "19:10", at(8, 20, 12)), "bad_slot");
});

test("選べる日は期間の終わりで止まる", () => {
  assert.deepEqual(selectableDates(at(8, 28, 6)), ["2026-08-28"]);
  assert.deepEqual(selectableDates(at(8, 20, 6)), ["2026-08-20", "2026-08-21"]);
});

test("期間の定数が仕様と合う", () => {
  assert.deepEqual(config.PERIOD.bath.night, ["2026-08-17", "2026-08-27"]);
  assert.deepEqual(config.PERIOD.bath.morning, ["2026-08-18", "2026-08-28"]);
});

test("枠の長さは浴室ごとに違う", () => {
  const now = at(8, 20, 12);
  assert.equal(checkReservable("2026-08-20", "night", "shower", "19:15", now), "ok");
  assert.equal(checkReservable("2026-08-20", "night", "tub", "19:15", now), "bad_slot");
  assert.equal(checkReservable("2026-08-20", "night", "tub", "19:20", now), "ok");
  assert.equal(checkReservable("2026-08-20", "night", "shower", "19:20", now), "bad_slot");
});

test("知らない浴室は取れない", () => {
  assert.equal(checkReservable("2026-08-20", "night", "sauna", "19:00", at(8, 20, 12)), "bad_slot");
});

test("夜は 25:00 まで届く", () => {
  const now = at(8, 20, 12);
  for (const room of ["shower", "tub"]) {
    assert.equal(checkReservable("2026-08-20", "night", room, "25:00", now), "ok");
  }
  assert.equal(checkReservable("2026-08-20", "night", "shower", "24:45", now), "ok");
  assert.equal(checkReservable("2026-08-20", "night", "tub", "24:40", now), "ok");
  assert.equal(checkReservable("2026-08-20", "night", "tub", "25:20", now), "bad_slot");
});

test("24 時以降の枠は翌朝を指す", () => {
  assert.equal(slotInstant("2026-08-20", "24:00"), at(8, 21, 0));
  assert.equal(slotInstant("2026-08-20", "25:00"), at(8, 21, 1));
});

test("深夜は前夜の続きとして扱う", () => {
  assert.equal(stayDate(at(8, 20, 23, 50)), "2026-08-20");
  assert.equal(stayDate(at(8, 21, 0, 30)), "2026-08-20");
  assert.equal(stayDate(at(8, 21, 4, 59)), "2026-08-20");
  assert.equal(stayDate(at(8, 21, 5, 0)), "2026-08-21");
});

test("0 時を回っても、まだ始まっていない前夜の枠は取れる", () => {
  const now = at(8, 21, 0, 30);
  assert.deepEqual(selectableDates(now), ["2026-08-20", "2026-08-21"]);
  assert.equal(checkReservable("2026-08-20", "night", "shower", "25:00", now), "ok");
  assert.equal(checkReservable("2026-08-20", "night", "shower", "24:15", now), "past");
});

test("深夜 3 時に、その朝 6 時の枠を取れる", () => {
  assert.equal(checkReservable("2026-08-21", "morning", "shower", "06:00", at(8, 21, 3)), "ok");
});

test("暦日として妥当でない指定は弾く", () => {
  assert.equal(jst.parseDay("2026-02-30"), null);
  assert.equal(jst.parseDay("2026-13-01"), null);
  assert.equal(jst.parseDay("2026-8-20"), null);
  assert.equal(jst.parseDay("2026-08-20"), "2026-08-20");
});
