/** 同時予約のテストが使う。全員が揃うまで待ってから、同じ枠へ一斉に押す。 */

import { parentPort, workerData } from "node:worker_threads";

import * as db from "../src/db.js";

const { dbPath, memberId, counter, gate, total } = workerData;

if (Atomics.add(counter, 0, 1) + 1 === total) {
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
} else {
  while (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0, 100);
}

const database = db.connect(dbPath);
try {
  parentPort.postMessage(db.reserve(database, "2026-08-20", "night", "shower", "19:00", memberId));
} finally {
  database.close();
}
