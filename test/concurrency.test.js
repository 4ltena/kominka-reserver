/** 同じ枠へ同時に押したとき、成立するのは 1 件だけであることを確かめる。 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import * as db from "../src/db.js";

const WORKERS = 10;
const WORKER_URL = new URL("../tools/race-worker.js", import.meta.url);

for (const attempt of [0, 1, 2]) {
  test(`同時に押しても 1 件だけ成立する (${attempt})`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kominka-race-"));
    const dbPath = path.join(dir, "race.db");

    const setup = db.connect(dbPath);
    db.initSchema(setup);
    const memberIds = Array.from({ length: WORKERS }, (_, i) => db.addMember(setup, `参加者${i}`));
    setup.close();

    const counter = new Int32Array(new SharedArrayBuffer(4));
    const gate = new Int32Array(new SharedArrayBuffer(4));

    const results = await Promise.all(
      memberIds.map(
        (memberId) =>
          new Promise((resolve, reject) => {
            const worker = new Worker(WORKER_URL, {
              workerData: { dbPath, memberId, counter, gate, total: WORKERS },
            });
            worker.once("message", resolve);
            worker.once("error", reject);
          }),
      ),
    );

    assert.equal(results.length, WORKERS);
    assert.equal(results.filter((r) => r === "ok").length, 1);
    assert.equal(results.filter((r) => r === "slot_taken").length, WORKERS - 1);

    const check = db.connect(dbPath);
    assert.equal(db.reservationsForDate(check, "2026-08-20").size, 1);
    check.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
