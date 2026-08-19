/**
 * 旧実装と同じポートに並べるため、途中に /ex を挟んで動かせることを確かめる。
 *
 * 画面の中の行き先が接頭辞を落とすと、隣で動いている旧実装へ飛んでしまう。
 * 生成された HTML まで見て、素の行き先が残っていないことを確かめる。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { normaliseBase } from "../src/app.js";
import { NOON, withSignedIn } from "./helpers.js";

const mounted = (run) => withSignedIn(NOON, run, { basePath: "/ex" });

test("基準パスの形を整える", () => {
  assert.equal(normaliseBase(""), "");
  assert.equal(normaliseBase("/ex"), "/ex");
  assert.equal(normaliseBase("ex"), "/ex");
  assert.equal(normaliseBase("/ex/"), "/ex");
  assert.equal(normaliseBase(undefined), "");
});

test("接頭辞の下でだけ応える", () => mounted(async ({ client }) => {
  assert.equal((await client.get("/ex/bath")).status, 200);
  assert.equal((await client.get("/bath")).status, 404);
  assert.equal((await client.get("/ex/api/v1/members")).status, 200);
  assert.equal((await client.get("/api/v1/members")).status, 404);
  assert.equal((await client.get("/ex/static/style.css")).status, 200);
}));

test("画面の中の行き先に素の URL が残らない", () => mounted(async ({ client }) => {
  for (const url of ["/ex/bath", "/ex/meals", "/ex/select", "/ex/members"]) {
    const html = await (await client.get(url)).text();
    const bare = [...html.matchAll(/(?:href|action)="(\/[^"]*)"/g)]
      .map((found) => found[1])
      .filter((target) => !target.startsWith("/ex/"));
    assert.deepEqual(bare, [], `${url} に素の行き先: ${bare.join(", ")}`);
  }
}));

test("自動更新の取得先にも接頭辞が付く", () => mounted(async ({ client }) => {
  const html = await (await client.get("/ex/bath")).text();
  assert.match(html, /data-fragment="\/ex\/fragment\/bath\?date=\d{4}-\d{2}-\d{2}"/);
  assert.match(await (await client.get("/ex/meals")).text(), /data-fragment="\/ex\/fragment\/meals"/);
}));

test("転送の行き先にも接頭辞が付く", () => mounted(async ({ base, client }) => {
  const response = await client.post("/ex/bath/reserve", {
    form: { date: "2026-08-20", section: "night", room: "shower", slot: "19:00" },
  });
  assert.equal(response.headers.get("location"), "/ex/bath?date=2026-08-20");

  const { makeClient } = await import("./helpers.js");
  const stranger = makeClient(base);
  assert.equal((await stranger.get("/ex/bath")).headers.get("location"), "/ex/select");
}));

test("cookie は接頭辞の下に閉じ込める", () => mounted(async ({ base }) => {
  const { makeClient } = await import("./helpers.js");
  const client = makeClient(base);
  const response = await client.post("/ex/select", { form: { member_id: "1" } });
  const cookie = response.headers.getSetCookie().find((raw) => raw.startsWith("member_id="));
  assert.match(cookie, /Path=\/ex/);
}));

test("接頭辞の下でも予約と投票が通る", () => mounted(async ({ client }) => {
  const reserved = await client.post("/ex/api/v1/bath/2026-08-20/reserve", {
    json: { member_id: 1, section: "night", room: "shower", slot: "19:00" },
  });
  assert.equal(reserved.status, 201);

  await client.post("/ex/meals/vote", {
    form: { date: "2026-08-20", kind: "dinner", size: "large" },
    follow: true,
  });
  const page = await (await client.get("/ex/meals")).text();
  assert.ok(page.includes("1合"));
  assert.ok(page.includes("あかり"));
}));
