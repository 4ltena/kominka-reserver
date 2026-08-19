/** 期間・枠・設定ファイルの定義。ここを書き換えれば日程を動かせる。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOMS = ["shower", "tub"];
export const ROOM_LABELS = { shower: "風呂", tub: "風呂（浴槽付き）" };

export const SECTIONS = ["morning", "night"];
export const SECTION_LABELS = { morning: "朝", night: "夜" };

export const MEALS = ["breakfast", "dinner"];
export const MEAL_LABELS = { breakfast: "朝", dinner: "晩" };

// 白米の量。合計の合数を炊く人が見る。
export const RICE_SIZES = ["normal", "large"];
export const RICE_LABELS = { normal: "通常", large: "大盛" };
export const RICE_GO = { normal: 0.5, large: 1.0 };

export const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];

// 滞在は 2026-08-17 の晩に始まり 2026-08-28 の朝に終わる。
export const PERIOD = {
  bath: {
    night: ["2026-08-17", "2026-08-27"],
    morning: ["2026-08-18", "2026-08-28"],
  },
  meal: {
    // 8/18 の朝ごはんは投票窓が閉じたあとに決まったため対象外。
    breakfast: ["2026-08-19", "2026-08-28"],
    dinner: ["2026-08-18", "2026-08-27"],
  },
};

// 枠の長さは浴室ごとに違う。浴槽付きは 20 分、浴槽なしは 15 分。
export const ROOM_SLOT_MINUTES = { shower: 15, tub: 20 };
export const SECTION_HOURS = { morning: [6, 8], night: [19, 24] };

// 夜の枠が翌 01:20 まで伸びるため、暦の日付では「今日」を判定できない。
// この時刻より前は前夜の続きとして扱う。朝風呂の開始 06:00 より前に置く。
export const DAY_CHANGE_HOUR = 5;
// 区分によっては最後の入浴開始時刻を明示する。指定が無ければ、枠が区分の
// 終了時刻をはみ出さない範囲で並べる。24 時以降は翌日を指し、25:00 は翌 01:00。
export const SECTION_LAST_START = { night: "25:00" };

// 食事の投票の締切。[対象日からの日数のずれ, 締切の時]。受付開始は設けない。
export const VOTE_DEADLINE = { breakfast: [-1, 22], dinner: [0, 18] };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CONFIG_PATH = path.join(ROOT, "config.toml");
export const DEFAULT_DB_PATH = path.join(ROOT, "data", "kominka-reserver.db");
export const VIEW_DIR = path.join(ROOT, "src", "views");
export const PUBLIC_DIR = path.join(ROOT, "public");

/**
 * config.toml から [server] の host と port だけを読む。
 *
 * TOML の解釈器を持ち込むほどの内容ではないため、表の見出しを追いながら 2 つの鍵
 * だけを拾う。他の表に同名の鍵があっても混ざらない。環境変数があれば上書きする。
 */
export function loadSettings(configPath = null) {
  const target = configPath ?? DEFAULT_CONFIG_PATH;
  const settings = { host: "0.0.0.0", port: 8080 };

  if (fs.existsSync(target)) {
    let inServer = false;
    for (const line of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
      const text = line.trim();
      if (text.startsWith("[")) {
        inServer = text === "[server]";
        continue;
      }
      if (!inServer) continue;
      const host = /^host\s*=\s*"([^"]*)"/.exec(text);
      const port = /^port\s*=\s*(\d+)/.exec(text);
      if (host !== null) settings.host = host[1];
      if (port !== null) settings.port = Number(port[1]);
    }
  }

  if (process.env.HOST) settings.host = process.env.HOST;
  if (process.env.PORT) settings.port = Number(process.env.PORT);
  return settings;
}
