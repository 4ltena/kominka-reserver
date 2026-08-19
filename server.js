/** 起動口。systemd からはこれを呼ぶ。 */

import { createApp } from "./src/app.js";
import { DEFAULT_DB_PATH, loadSettings } from "./src/config.js";

const settings = loadSettings();
const app = createApp({
  dbPath: process.env.DB_PATH ?? DEFAULT_DB_PATH,
  basePath: process.env.BASE_PATH ?? "",
});

app.listen(settings.port, settings.host, () => {
  const base = app.locals.basePath || "/";
  console.log(`kominka-reserver listening on ${settings.host}:${settings.port} at ${base}`);
});
