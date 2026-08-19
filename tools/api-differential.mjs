/**
 * Flask と Express を同時に立て、同じ要求への応答を突き合わせる。
 *
 * 読み取りは 1 つのデータベースを共有させ、書き込みはそれぞれの複製に対して
 * 同じ順番で流す。now は本来ずれるため、比較の前に伏せる。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { clock } from "../src/clock.js";
import * as config from "../src/config.js";
import * as db from "../src/db.js";
import * as jst from "../src/jst.js";
import * as meals from "../src/meals.js";

const NOW = jst.instant("2026-08-20", 21, 30);
const NOW_ISO = jst.iso(NOW);
const PY_PORT = 8391;
const JS_PORT = 8392;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kominka-diff-"));
const sharedDb = path.join(dir, "shared.db");

// --- 種を蒔く -------------------------------------------------------------

clock.now = () => NOW;
{
  const d = db.connect(sharedDb);
  db.initSchema(d);
  const names = ["あかり", "ゆうと", "そら", "うみ", "かえで"];
  const ids = names.map((name) => db.addMember(d, name));
  db.setMemberActive(d, ids[4], false);
  db.reserve(d, "2026-08-20", "night", "shower", "19:00", ids[0]);
  db.reserve(d, "2026-08-20", "night", "tub", "22:00", ids[1]);
  db.reserve(d, "2026-08-20", "morning", "shower", "06:30", ids[0]);
  db.reserve(d, "2026-08-21", "night", "shower", "25:00", ids[2]);
  db.vote(d, "2026-08-20", "dinner", ids[0], "large");
  db.vote(d, "2026-08-20", "dinner", ids[1], "normal");
  db.vote(d, "2026-08-21", "breakfast", ids[2], "normal");
  d.close();
}

// --- 立てる ---------------------------------------------------------------

const children = [];
function start(command, args) {
  const child = spawn(command, args, {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, PYTHONPATH: "." },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  return child;
}

async function waitFor(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/v1/members`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`${port} が上がらない`);
}

// --- 比べる ---------------------------------------------------------------

const problems = [];
const known = [];
let checked = 0;

/**
 * 移行にあたって受け入れた差異。応答の意味は変えず、文面だけが変わる。
 * ここに載らない食い違いは問題として報告する。
 */
const KNOWN = [
  {
    reason: "転送の本文。Flask は HTML の案内、Express は平文。Location は同じ",
    applies: (py) => py.status >= 300 && py.status < 400,
  },
  {
    reason: "経路違いの detail。Werkzeug の英文を日本語にした。error は同じ",
    applies: (py, left, right) => {
      try {
        const a = JSON.parse(left);
        const b = JSON.parse(right);
        return a.error === "not_found" && b.error === "not_found" && a.detail !== b.detail;
      } catch {
        return false;
      }
    },
  },
];

/** 応答を比較できる形にする。now と、伏せた差異を取り除く。 */
function normalise(text, contentType) {
  if ((contentType ?? "").includes("application/json")) {
    const value = JSON.parse(text);
    if (value !== null && typeof value === "object" && "now" in value) value.now = "(now)";
    return JSON.stringify(sortKeys(value));
  }
  return text.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
}

async function compare(label, request) {
  const [py, js] = await Promise.all([
    fetch(`http://127.0.0.1:${PY_PORT}${request.url}`, request.init),
    fetch(`http://127.0.0.1:${JS_PORT}${request.url}`, request.init),
  ]);
  checked += 1;

  const [pyText, jsText] = await Promise.all([py.text(), js.text()]);
  const pyType = py.headers.get("content-type");
  const jsType = js.headers.get("content-type");

  if (py.status !== js.status) {
    problems.push(`${label}: 状態 ${py.status} と ${js.status}`);
    return;
  }
  // 転送は本文ではなく行き先が合っていればよい。
  if (py.headers.get("location") !== js.headers.get("location")) {
    problems.push(
      `${label}: 行き先 ${py.headers.get("location")} と ${js.headers.get("location")}`,
    );
    return;
  }

  const left = normalise(pyText, pyType);
  const right = normalise(jsText, jsType);
  if (left === right) return;

  const excuse = KNOWN.find((entry) => entry.applies(py, left, right));
  if (excuse !== undefined) {
    known.push(`${label} — ${excuse.reason}`);
    return;
  }
  problems.push(`${label}:\n    Flask   ${left.slice(0, 300)}\n    Express ${right.slice(0, 300)}`);
}

const days = [];
for (let day = "2026-08-16"; day <= "2026-08-29"; day = jst.addDays(day, 1)) days.push(day);

async function readOnlyRound() {
  await compare("GET /api/v1/members", { url: "/api/v1/members" });
  await compare("GET /api/v1/meals", { url: "/api/v1/meals" });
  await compare("GET /api/v1/meals?all=true", { url: "/api/v1/meals?all=true" });

  for (const meal of meals.allMeals()) {
    await compare(`GET meal ${meal.day} ${meal.kind}`, {
      url: `/api/v1/meals/${meal.day}/${meal.kind}`,
    });
  }
  for (const day of days) {
    await compare(`GET bath ${day}`, { url: `/api/v1/bath/${day}` });
  }

  // 経路と引数の誤り。書き込みは起きない。
  const failures = [
    "/api/v1/nope",
    "/api/v1/members/",
    "/api/v1/bath/2026-13-99",
    "/api/v1/bath/notadate",
    "/api/v1/meals/2026-08-20/lunch",
    "/api/v1/meals/abc/dinner",
    "/api/v1/meals/2026-08-29/dinner",
  ];
  for (const url of failures) await compare(`GET ${url}`, { url });

  // 画面。テンプレートを移し替えているので中身まで見る。
  const cookie = { headers: { cookie: "member_id=1" } };
  for (const url of ["/select", "/members", "/meals", "/bath", "/bath?date=2026-08-21",
                     "/bath?date=2026-08-29", "/fragment/meals", "/fragment/bath?date=2026-08-20"]) {
    await compare(`GET ${url}`, { url, init: cookie });
  }
  await compare("GET /bath (cookie 無し)", { url: "/bath", init: { redirect: "manual" } });
}

async function writeRound() {
  const send = (url, method, body) => ({
    url,
    init: {
      method,
      headers: { "content-type": "application/json", cookie: "member_id=2" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    },
  });

  const steps = [
    ["予約", send("/api/v1/bath/2026-08-21/reserve", "POST",
      { member_id: 2, section: "night", room: "tub", slot: "21:00" })],
    ["同じ枠をもう一度", send("/api/v1/bath/2026-08-21/reserve", "POST",
      { member_id: 3, section: "night", room: "tub", slot: "21:00" })],
    ["同じ区分で 2 枠目", send("/api/v1/bath/2026-08-21/reserve", "POST",
      { member_id: 2, section: "night", room: "shower", slot: "23:00" })],
    ["始まった枠", send("/api/v1/bath/2026-08-20/reserve", "POST",
      { member_id: 3, section: "night", room: "shower", slot: "20:00" })],
    ["遠い日", send("/api/v1/bath/2026-08-23/reserve", "POST",
      { member_id: 3, section: "night", room: "shower", slot: "20:00" })],
    ["知らない浴室", send("/api/v1/bath/2026-08-21/reserve", "POST",
      { member_id: 3, section: "night", room: "sauna", slot: "20:00" })],
    ["名簿に無い人", send("/api/v1/bath/2026-08-21/reserve", "POST",
      { member_id: 99, section: "night", room: "shower", slot: "23:00" })],
    ["member_id 無し", send("/api/v1/bath/2026-08-21/reserve", "POST",
      { section: "night", room: "shower", slot: "23:00" })],
    ["member_id が文字", send("/api/v1/bath/2026-08-21/reserve", "POST",
      { member_id: "abc", section: "night", room: "shower", slot: "23:00" })],
    ["取り消し（他人）", send("/api/v1/bath/reservations/1", "DELETE", { member_id: 3 })],
    ["取り消し（本人）", send("/api/v1/bath/reservations/1", "DELETE", { member_id: 1 })],
    ["取り消し（無い）", send("/api/v1/bath/reservations/999", "DELETE", { member_id: 1 })],
    ["挙手", send("/api/v1/meals/2026-08-21/dinner/vote", "POST", { member_id: 2, size: "large" })],
    ["量の差し替え", send("/api/v1/meals/2026-08-21/dinner/vote", "POST", { member_id: 2, size: "normal" })],
    ["知らない量", send("/api/v1/meals/2026-08-21/dinner/vote", "POST", { member_id: 2, size: "特盛" })],
    ["締切後", send("/api/v1/meals/2026-08-20/dinner/vote", "POST", { member_id: 2, size: "normal" })],
    ["挙手の取り消し", send("/api/v1/meals/2026-08-21/dinner/vote", "DELETE", { member_id: 2 })],
    ["挙手していないのに取り消し", send("/api/v1/meals/2026-08-21/dinner/vote", "DELETE", { member_id: 4 })],
    ["画面から予約", { url: "/bath/reserve", init: {
      method: "POST", redirect: "manual", headers: {
        "content-type": "application/x-www-form-urlencoded", cookie: "member_id=2" },
      body: new URLSearchParams(
        { date: "2026-08-21", section: "morning", room: "tub", slot: "07:00" }).toString() } }],
    ["画面から投票", { url: "/meals/vote", init: {
      method: "POST", redirect: "manual", headers: {
        "content-type": "application/x-www-form-urlencoded", cookie: "member_id=2" },
      body: new URLSearchParams(
        { date: "2026-08-21", kind: "dinner", size: "large" }).toString() } }],
  ];

  for (const [label, request] of steps) await compare(label, request);
  // 書き込んだあとの状態も揃っているか。
  await compare("書き込み後 bath 8/21", { url: "/api/v1/bath/2026-08-21" });
  await compare("書き込み後 meals", { url: "/api/v1/meals?all=true" });
}

// --- 進める ---------------------------------------------------------------

try {
  // 読み取りは同じファイルを 2 つのプロセスで開く。並走時と同じ形になる。
  start(".venv/bin/python", ["tools/serve-fixed.py", NOW_ISO, sharedDb, String(PY_PORT)]);
  start("node", ["tools/serve-fixed.mjs", String(NOW), sharedDb, String(JS_PORT)]);
  await Promise.all([waitFor(PY_PORT), waitFor(JS_PORT)]);
  await readOnlyRound();
  console.log(`読み取り ${checked} 件`);

  for (const child of children.splice(0)) child.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 書き込みは別々の複製に対して同じ順番で流す。
  const pyDb = path.join(dir, "py.db");
  const jsDb = path.join(dir, "js.db");
  fs.copyFileSync(sharedDb, pyDb);
  fs.copyFileSync(sharedDb, jsDb);
  const before = checked;
  start(".venv/bin/python", ["tools/serve-fixed.py", NOW_ISO, pyDb, String(PY_PORT)]);
  start("node", ["tools/serve-fixed.mjs", String(NOW), jsDb, String(JS_PORT)]);
  await Promise.all([waitFor(PY_PORT), waitFor(JS_PORT)]);
  await writeRound();
  console.log(`書き込み ${checked - before} 件`);
} finally {
  for (const child of children) child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n照合 ${checked} 件`);
if (known.length > 0) {
  console.log(`既知の差異 ${known.length} 件:`);
  for (const entry of known) console.log(`  ${entry}`);
  console.log("");
}
if (problems.length === 0) {
  console.log("既知の差異を除き、すべて一致");
} else {
  console.log(`一致しない ${problems.length} 件:\n`);
  for (const problem of problems) console.log(`  ${problem}`);
  process.exitCode = 1;
}
