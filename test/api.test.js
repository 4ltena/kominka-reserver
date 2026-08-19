import assert from "node:assert/strict";
import { test } from "node:test";

import { at, NOON, withMembers } from "./helpers.js";

const json = async (response) => response.json();
const isJson = (response) => (response.headers.get("content-type") ?? "").includes("application/json");

// --- 名簿 -----------------------------------------------------------------

test("名簿", () => withMembers(NOON, async ({ client }) => {
  const body = await json(await client.get("/api/v1/members"));
  assert.equal(body.registered, 2);
  assert.deepEqual(body.members[0], { id: 1, name: "あかり" });
}));

// --- 食事 -----------------------------------------------------------------

test("食事の一覧は画面と同じ 4 件", () => withMembers(NOON, async ({ client }) => {
  const body = await json(await client.get("/api/v1/meals"));
  assert.equal(body.meals.length, 4);
  assert.deepEqual(Object.keys(body.meals[0]).sort(),
    ["by_size", "date", "deadline", "go", "meal", "people", "registered", "state"]);
  assert.ok(body.meals[0].deadline.endsWith("+09:00"));
  assert.ok(body.now.endsWith("+09:00"));
}));

test("?all=true で全食事", () => withMembers(NOON, async ({ client }) => {
  assert.equal((await json(await client.get("/api/v1/meals?all=true"))).meals.length, 20);
}));

test("挙手と集計", () => withMembers(NOON, async ({ client }) => {
  const url = "/api/v1/meals/2026-08-20/dinner/vote";

  let body = await json(await client.post(url, { json: { member_id: 1, size: "large" } }));
  assert.deepEqual([body.go, body.people], [1, 1]);
  assert.deepEqual(body.by_size, { normal: 0, large: 1 });

  body = await json(await client.post(url, { json: { member_id: 2, size: "normal" } }));
  assert.deepEqual([body.go, body.people], [1.5, 2]);

  // もう一度押すと量が差し替わり、人数は増えない。
  body = await json(await client.post(url, { json: { member_id: 1, size: "normal" } }));
  assert.deepEqual([body.go, body.people], [1, 2]);
}));

test("挙手の取り消し", () => withMembers(NOON, async ({ client }) => {
  const url = "/api/v1/meals/2026-08-20/dinner/vote";
  await client.post(url, { json: { member_id: 1, size: "large" } });
  const body = await json(await client.delete(url, { json: { member_id: 1 } }));
  assert.deepEqual([body.go, body.people], [0, 0]);
}));

test("DELETE に本体を付けられない client のため query も受ける", () =>
  withMembers(NOON, async ({ client }) => {
    const url = "/api/v1/meals/2026-08-20/dinner/vote";
    await client.post(url, { json: { member_id: 1, size: "large" } });
    assert.equal((await client.delete(`${url}?member_id=1`)).status, 200);
  }));

test("締切後の挙手", () => withMembers(NOON, async ({ client }) => {
  const response = await client.post("/api/v1/meals/2026-08-20/breakfast/vote", {
    json: { member_id: 1, size: "normal" },
  });
  assert.equal(response.status, 409);
  const body = await json(response);
  assert.equal(body.error, "deadline_passed");
  assert.ok(body.deadline.endsWith("+09:00"));
}));

test("挙手の引数の誤り", () => withMembers(NOON, async ({ client }) => {
  const url = "/api/v1/meals/2026-08-20/dinner/vote";
  const error = async (options, path = url) => (await json(await client.post(path, options))).error;
  assert.equal(await error({ json: { member_id: 99, size: "normal" } }), "unknown_member");
  assert.equal(await error({ json: { member_id: 1, size: "特盛" } }), "bad_size");
  assert.equal(await error({ json: { size: "normal" } }), "bad_request");

  const far = await client.post("/api/v1/meals/2026-08-29/dinner/vote", {
    json: { member_id: 1, size: "normal" },
  });
  assert.equal(far.status, 404);
  assert.equal((await json(far)).error, "unknown_meal");
}));

// --- 風呂 -----------------------------------------------------------------

test("その日の枠", () => withMembers(NOON, async ({ client }) => {
  const body = await json(await client.get("/api/v1/bath/2026-08-20"));
  assert.equal(body.selectable, true);
  assert.deepEqual(body.sections.map((s) => s.section), ["morning", "night"]);

  const night = body.sections.find((s) => s.section === "night");
  const shower = night.rooms.find((r) => r.room === "shower");
  assert.equal(shower.minutes, 15);
  assert.equal(shower.slots.at(-1).slot, "25:00");
  // 25:00 は翌日を指す。
  assert.ok(shower.slots.at(-1).starts_at.startsWith("2026-08-21T01:00"));
  // 正午なので朝は済んでいる。
  const morning = body.sections.find((s) => s.section === "morning");
  assert.equal(morning.rooms[0].slots[0].state, "past");
}));

test("期間外の日", () => withMembers(NOON, async ({ client }) => {
  assert.equal((await json(await client.get("/api/v1/bath/2026-08-29"))).error, "not_in_period");
}));

test("予約と取り消し", () => withMembers(NOON, async ({ client }) => {
  const payload = { member_id: 1, section: "night", room: "shower", slot: "19:00" };
  const response = await client.post("/api/v1/bath/2026-08-20/reserve", { json: payload });
  assert.equal(response.status, 201);
  const body = await json(response);
  assert.equal(body.name, "あかり");
  assert.ok(body.starts_at.startsWith("2026-08-20T19:00"));

  const taken = await client.post("/api/v1/bath/2026-08-20/reserve", {
    json: { ...payload, member_id: 2 },
  });
  assert.equal(taken.status, 409);
  assert.equal((await json(taken)).error, "slot_taken");

  const second = await json(
    await client.post("/api/v1/bath/2026-08-20/reserve", {
      json: { member_id: 1, section: "night", room: "tub", slot: "20:00" },
    }),
  );
  assert.equal(second.error, "already_has");
  assert.equal(second.held.slot, "19:00");

  const id = body.reservation_id;
  assert.equal((await client.delete(`/api/v1/bath/reservations/${id}`, { json: { member_id: 2 } })).status, 404);
  assert.equal((await client.delete(`/api/v1/bath/reservations/${id}`, { json: { member_id: 1 } })).status, 200);
}));

test("始まった枠と遠い日と知らない浴室", () => withMembers(NOON, async ({ client }) => {
  const error = async (day, payload) =>
    (await json(await client.post(`/api/v1/bath/${day}/reserve`, { json: payload }))).error;

  assert.equal(
    await error("2026-08-20", { member_id: 1, section: "morning", room: "shower", slot: "06:00" }),
    "slot_started",
  );
  assert.equal(
    await error("2026-08-22", { member_id: 1, section: "night", room: "shower", slot: "19:00" }),
    "not_selectable_date",
  );
  assert.equal(
    await error("2026-08-20", { member_id: 1, section: "night", room: "sauna", slot: "19:00" }),
    "bad_slot",
  );
}));

test("API で入れた挙手が画面に出る", () => withMembers(NOON, async ({ client }) => {
  await client.post("/api/v1/meals/2026-08-20/dinner/vote", { json: { member_id: 1, size: "large" } });
  client.setCookie("member_id", "1");
  const page = await (await client.get("/meals")).text();
  assert.ok(page.includes("1合"));
  assert.ok(page.includes("いる 1人 / 登録 2人"));
}));

// --- 経路の間違い ---------------------------------------------------------

test("経路や method の間違いでも JSON を返す", () => withMembers(NOON, async ({ client }) => {
  const cases = [
    [await client.get("/api/v1/nope"), "not_found"],
    [await client.get("/api/v1/members/"), "not_found"],
    [await client.post("/api/v1/members"), "method_not_allowed"],
    [await client.delete("/api/v1/bath/reservations/abc"), "not_found"],
    [await client.put("/api/v1/bath/2026-08-20"), "method_not_allowed"],
  ];
  for (const [response, code] of cases) {
    const text = await response.text();
    assert.ok(isJson(response), text.slice(0, 80));
    assert.equal(JSON.parse(text).error, code);
  }
}));

test("画面側は今までどおり HTML", () => withMembers(NOON, async ({ client }) => {
  assert.ok(!isJson(await client.get("/nope")));
}));

test("壊れた JSON はその旨を返す", () => withMembers(NOON, async ({ client }) => {
  const response = await client.post("/api/v1/meals/2026-08-20/dinner/vote", { raw: "{oops" });
  assert.equal(response.status, 400);
  assert.ok((await json(response)).detail.includes("JSON"));
}));

test("member_id が数でないとき", () => withMembers(NOON, async ({ client }) => {
  const body = await json(
    await client.post("/api/v1/meals/2026-08-20/dinner/vote", {
      json: { member_id: "abc", size: "normal" },
    }),
  );
  assert.equal(body.error, "bad_request");
  assert.ok(body.detail.includes("整数"));
}));

// --- 受け取り方の揺れ -----------------------------------------------------

test("all はよくある綴りを受ける", () => withMembers(NOON, async ({ client }) => {
  for (const raw of ["true", "1", "yes", "TRUE"]) {
    assert.equal((await json(await client.get(`/api/v1/meals?all=${raw}`))).meals.length, 20);
  }
}));

test("フォームでもクエリでも受ける", () => withMembers(NOON, async ({ client }) => {
  const url = "/api/v1/meals/2026-08-20/dinner/vote";
  let body = await json(await client.post(url, { form: { member_id: "1", size: "normal" } }));
  assert.deepEqual([body.go, body.people], [0.5, 1]);
  body = await json(await client.post(`${url}?member_id=2&size=large`));
  assert.deepEqual([body.go, body.people], [1.5, 2]);
}));

test("名前をそのまま返す", () => withMembers(NOON, async ({ client }) => {
  assert.ok((await (await client.get("/api/v1/members")).text()).includes("あかり"));
}));

test("合数は数値で、挙手が無ければ 0", () => withMembers(NOON, async ({ client }) => {
  const body = await json(await client.get("/api/v1/meals/2026-08-27/dinner"));
  assert.equal(typeof body.go, "number");
  assert.equal(body.go, 0);
}));

// --- 予約できるかを枠ごとに示す -------------------------------------------

test("受け付けていない日の空き枠は reservable が false", () =>
  withMembers(NOON, async ({ client }) => {
    const far = await json(await client.get("/api/v1/bath/2026-08-22"));
    assert.equal(far.selectable, false);
    const slot = far.sections[0].rooms[0].slots[0];
    assert.equal(slot.state, "free");
    assert.equal(slot.reservable, false);

    const near = await json(await client.get("/api/v1/bath/2026-08-20"));
    const night = near.sections.find((s) => s.section === "night");
    assert.equal(night.rooms[0].slots[0].reservable, true);
    const morning = near.sections.find((s) => s.section === "morning");
    assert.equal(morning.rooms[0].slots[0].reservable, false); // 正午なので済んでいる
  }));

test("深夜でも前夜の枠を API から取れる", () => withMembers(at(8, 21, 0, 30), async ({ client }) => {
  const response = await client.post("/api/v1/bath/2026-08-20/reserve", {
    json: { member_id: 1, section: "night", room: "shower", slot: "25:00" },
  });
  assert.equal(response.status, 201);
  assert.ok((await json(response)).starts_at.startsWith("2026-08-21T01:00"));
}));
