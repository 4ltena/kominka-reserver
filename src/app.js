/** アプリの組み立て。画面と API が同じデータベース接続を見る。 */

import express from "express";

import { createApiRouter, PREFIX } from "./api.js";
import * as config from "./config.js";
import * as db from "./db.js";
import { createWebRouter } from "./web.js";

/**
 * 基準パスを整える。"" か "/ex" の形にする。
 *
 * 旧実装と同じポートで並べるとき、前段の振り分けがこの接頭辞で 2 つを分ける。
 * アプリ側も自分の URL をこの接頭辞付きで組み立てないと、画面の中の行き先が
 * 隣の実装へ飛んでしまう。
 */
export function normaliseBase(raw) {
  const trimmed = String(raw ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function createApp({ dbPath = config.DEFAULT_DB_PATH, basePath = "" } = {}) {
  const base = normaliseBase(basePath);
  const database = db.connect(dbPath);
  db.initSchema(database);

  const root = express.Router({ strict: true });
  root.use("/static", express.static(config.PUBLIC_DIR));
  root.use(PREFIX, createApiRouter(database));
  root.use(createWebRouter(database, base));

  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  app.set("strict routing", true);
  if (base === "") app.use(root);
  else app.use(base, root);

  app.locals.db = database;
  app.locals.dbPath = String(dbPath);
  app.locals.basePath = base;
  return app;
}
