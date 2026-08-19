import assert from "node:assert/strict";
import { test } from "node:test";

import * as db from "../src/db.js";
import { at, NOON, makeClient, withApp, withSignedIn } from "./helpers.js";

const includes = async (response, ...needles) => {
  const text = await response.text();
  for (const needle of needles) assert.ok(text.includes(needle), `${needle} が無い`);
  return text;
};

const excludes = async (response, ...needles) => {
  const text = await response.text();
  for (const needle of needles) assert.ok(!text.includes(needle), `${needle} が出ている`);
  return text;
};

const RESERVE = { date: "2026-08-20", section: "night", room: "shower", slot: "19:00" };

test("cookie が無ければ名前の選択へ送る", () => withApp(NOON, async ({ client }) => {
  const response = await client.get("/bath");
  assert.equal(response.status, 302);
  assert.ok(response.headers.get("location").endsWith("/select"));
}));

test("名簿が空なら選択画面がそう言う", () => withApp(NOON, async ({ client }) => {
  await includes(await client.get("/select"), "名簿が空です");
}));

test("予約すると自分の名前と取消が出る", () => withSignedIn(NOON, async ({ client }) => {
  await includes(await client.post("/bath/reserve", { form: RESERVE, follow: true }),
    "あかり", "取消");
}));

test("先に取られた枠はその旨を出す", () => withSignedIn(NOON, async ({ base, client }) => {
  await client.post("/bath/reserve", { form: RESERVE });
  const other = makeClient(base);
  other.setCookie("member_id", "2");
  await includes(await other.post("/bath/reserve", { form: RESERVE, follow: true }),
    "ちょうど埋まりました");
}));

test("2 枠目は持っている枠を知らせる", () => withSignedIn(NOON, async ({ client }) => {
  await client.post("/bath/reserve", { form: RESERVE });
  await includes(
    await client.post("/bath/reserve", {
      form: { date: "2026-08-20", section: "night", room: "tub", slot: "20:00" },
      follow: true,
    }),
    "19:00", "風呂を予約済み",
  );
}));

test("始まった枠は断る", () => withSignedIn(NOON, async ({ client }) => {
  await includes(
    await client.post("/bath/reserve", {
      form: { date: "2026-08-20", section: "morning", room: "shower", slot: "06:00" },
      follow: true,
    }),
    "その枠は始まっています",
  );
}));

test("他人の予約には取消が付かない", () => withSignedIn(NOON, async ({ client, db: d }) => {
  db.reserve(d, "2026-08-20", "night", "shower", "19:00", 2);
  const text = await includes(await client.get("/bath?date=2026-08-20"), "ゆうと");
  assert.ok(!text.includes("取消"));
}));

test("期間外の日はその旨を出す", () => withSignedIn(at(8, 28, 5), async ({ client }) => {
  await includes(await client.get("/bath?date=2026-08-29"), "対象期間外");
}));

test("量を選んで挙手し、取り消す", () => withSignedIn(NOON, async ({ client }) => {
  await includes(await client.get("/meals"), "通常", "大盛", "0合");

  const vote = (size) =>
    client.post("/meals/vote", {
      form: { date: "2026-08-20", kind: "dinner", size },
      follow: true,
    });

  await includes(await vote("normal"), "通常 ✓", "0.5合", "いる 1人 / 登録 2人");
  await includes(await vote("large"), "大盛 ✓", "いる 1人 / 登録 2人");
  await includes(
    await client.post("/meals/unvote", {
      form: { date: "2026-08-20", kind: "dinner" },
      follow: true,
    }),
    "いる 0人 / 登録 2人",
  );
}));

test("2 人分の量が足される", () => withSignedIn(NOON, async ({ base, client }) => {
  const other = makeClient(base);
  other.setCookie("member_id", "2");
  await client.post("/meals/vote", { form: { date: "2026-08-20", kind: "dinner", size: "large" } });
  await other.post("/meals/vote", { form: { date: "2026-08-20", kind: "dinner", size: "normal" } });
  await includes(await client.get("/meals"), "1.5合", "いる 2人 / 登録 2人");
}));

test("締め切った食事は挙手できない", () => withSignedIn(NOON, async ({ client, db: d }) => {
  await includes(
    await client.post("/meals/vote", {
      form: { date: "2026-08-20", kind: "breakfast", size: "normal" },
      follow: true,
    }),
    "受付時間外です",
  );
  assert.deepEqual(db.riceSummary(d, "2026-08-20", "breakfast"), { people: 0, total: 0 });
}));

test("受付開始が無いので「から」を出さない", () => withSignedIn(NOON, async ({ client }) => {
  const text = await includes(await client.get("/meals"), "8/21 18:00 まで");
  assert.ok(!text.includes("から"));
}));

test("名簿は読み取り専用", () => withSignedIn(NOON, async ({ client }) => {
  await includes(await client.get("/members"), "あかり", "ゆうと");
  await excludes(await client.get("/members"), "追加", "非表示");
  assert.equal((await client.post("/members", { form: { name: "そら" } })).status, 405);
  assert.equal((await client.post("/members/hide", { form: { member_id: "1" } })).status, 404);
}));

test("外部へ転送させる指定は無視する", () => withSignedIn(NOON, async ({ client }) => {
  const response = await client.post("/select", {
    form: { member_id: "1", next: "https://example.com/steal" },
  });
  assert.ok(response.headers.get("location").endsWith("/bath"));
}));

test("知らせは一度出したら消える", () => withSignedIn(NOON, async ({ client }) => {
  await client.post("/bath/reserve", {
    form: { date: "2026-08-20", section: "morning", room: "shower", slot: "06:00" },
    follow: true,
  });
  await excludes(await client.get("/bath"), "その枠は始まっています");
}));

test("cookie に書いた任意の文面は画面に出ない", () => withSignedIn(NOON, async ({ base }) => {
  const client = makeClient(base);
  client.setCookie("member_id", "1");
  client.setCookie("notice", "<script>alert(1)</script>");
  await excludes(await client.get("/bath"), "alert(1)");
}));
