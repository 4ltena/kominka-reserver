/** テストの下ごしらえ。pytest の conftest.py にあたる。 */

import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../src/app.js";
import { clock } from "../src/clock.js";
import * as db from "../src/db.js";
import * as jst from "../src/jst.js";

export const at = (month, day, hour, minute = 0) =>
  jst.instant(`2026-${jst.pad(month)}-${jst.pad(day)}`, hour, minute);

export const NOON = at(8, 20, 12);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kominka-"));
}

/** cookie を覚えて持ち回る client。Flask の test_client にあたる。 */
export function makeClient(base) {
  const jar = new Map();

  function absorb(response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const gone = attributes.some((attribute) => {
        const text = attribute.trim().toLowerCase();
        if (text.startsWith("max-age=")) return Number(text.slice(8)) <= 0;
        if (text.startsWith("expires=")) return new Date(attribute.trim().slice(8)) <= new Date();
        return false;
      });
      if (gone) jar.delete(name);
      else jar.set(name, decodeURIComponent(pair.slice(at + 1).trim()));
    }
  }

  async function send(method, url, options = {}) {
    const headers = {};
    if (jar.size > 0) {
      headers.cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    }
    let body;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(options.form).toString();
    } else if (options.raw !== undefined) {
      headers["content-type"] = options.contentType ?? "application/json";
      body = options.raw;
    }

    let response = await fetch(base + url, { method, headers, body, redirect: "manual" });
    absorb(response);

    let hops = 0;
    while (options.follow && response.status >= 300 && response.status < 400 && hops++ < 5) {
      response = await fetch(base + response.headers.get("location"), {
        headers: jar.size > 0
          ? { cookie: [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") }
          : {},
        redirect: "manual",
      });
      absorb(response);
    }
    return response;
  }

  return {
    setCookie: (name, value) => jar.set(name, value),
    get: (url, options) => send("GET", url, options),
    post: (url, options) => send("POST", url, options),
    delete: (url, options) => send("DELETE", url, options),
    put: (url, options) => send("PUT", url, options),
    send,
  };
}

/** 現在時刻を固定したアプリを立て、後片付けまで面倒を見る。 */
export async function withApp(now, run) {
  const previous = clock.now;
  clock.now = () => now;
  const dir = tempDir();
  const app = createApp({ dbPath: path.join(dir, "web.db") });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run({ app, base, db: app.locals.db, client: makeClient(base) });
  } finally {
    clock.now = previous;
    await new Promise((resolve) => server.close(resolve));
    app.locals.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 名簿に 2 人入れ、1 人目として入った client を渡す。 */
export function withSignedIn(now, run) {
  return withApp(now, async (context) => {
    const first = db.addMember(context.db, "あかり");
    db.addMember(context.db, "ゆうと");
    context.client.setCookie("member_id", String(first));
    await run(context);
  });
}

/** 名簿に 2 人入れただけの、cookie を持たない client。API のテストが使う。 */
export function withMembers(now, run) {
  return withApp(now, async (context) => {
    db.addMember(context.db, "あかり");
    db.addMember(context.db, "ゆうと");
    await run(context);
  });
}

/** サーバを立てずにデータベースだけ使う。 */
export function withDb(run) {
  const dir = tempDir();
  const database = db.connect(path.join(dir, "test.db"));
  db.initSchema(database);
  try {
    return run(database, dir);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
