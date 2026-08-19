import assert from "node:assert/strict";
import { test } from "node:test";

import { allMeals, visibleMeals, voteDeadline, voteState } from "../src/meals.js";
import { at } from "./helpers.js";

test("朝ごはんの締切は前日の晩", () => {
  assert.equal(voteDeadline({ day: "2026-08-19", kind: "breakfast" }), at(8, 18, 22));
});

test("晩ごはんの締切は当日", () => {
  assert.equal(voteDeadline({ day: "2026-08-19", kind: "dinner" }), at(8, 19, 18));
});

test("受付開始の下限は無い", () => {
  const meal = { day: "2026-08-19", kind: "dinner" };
  assert.equal(voteState(meal, at(8, 17, 3)), "open");
  assert.equal(voteState(meal, at(8, 19, 8, 59)), "open");
  assert.equal(voteState(meal, at(8, 19, 17, 59)), "open");
  assert.equal(voteState(meal, at(8, 19, 18)), "closed");
});

test("全食事の端", () => {
  const meals = allMeals();
  const has = (day, kind) => meals.some((m) => m.day === day && m.kind === kind);
  assert.deepEqual(meals[0], { day: "2026-08-18", kind: "dinner" });
  assert.ok(!has("2026-08-18", "breakfast"));
  assert.deepEqual(meals.at(-1), { day: "2026-08-28", kind: "breakfast" });
  assert.ok(!has("2026-08-28", "dinner"));
  assert.ok(!has("2026-08-17", "dinner"));
  assert.equal(meals.length, 20);
});

test("全食事は締切の順に並ぶ", () => {
  const deadlines = allMeals().map(voteDeadline);
  assert.deepEqual(deadlines, [...deadlines].sort((a, b) => a - b));
});

test("締め切った 1 件を残して 4 件見せる", () => {
  const now = at(8, 20, 20);
  const visible = visibleMeals(now);
  assert.equal(visible.length, 4);
  assert.equal(voteState(visible[0], now), "closed");
  assert.equal(visible.filter((m) => voteState(m, now) === "closed").length, 1);
});
