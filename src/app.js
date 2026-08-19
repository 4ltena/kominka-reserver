/** アプリの組み立て。画面と API が同じデータベース接続を見る。 */

import express from "express";

import { createApiRouter, PREFIX } from "./api.js";
import * as config from "./config.js";
import * as db from "./db.js";
import { createWebRouter } from "./web.js";

export function createApp({ dbPath = config.DEFAULT_DB_PATH } = {}) {
  const database = db.connect(dbPath);
  db.initSchema(database);

  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  app.set("strict routing", true);
  app.use("/static", express.static(config.PUBLIC_DIR));
  app.use(PREFIX, createApiRouter(database));
  app.use(createWebRouter(database));

  app.locals.db = database;
  app.locals.dbPath = String(dbPath);
  return app;
}
