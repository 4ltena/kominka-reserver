/**
 * 風呂の枠が始まる 5 分前に、予約した本人を Slack でメンションする。
 *
 * アプリの外から /api/v1/ を呼ぶ客として振る舞い、アプリのモジュールを import しない。
 * このファイルと対応表だけで動くため、別の機体へ置いて API_BASE を向けてもよい。
 *
 * 予約が入ったことをアプリから知らされる仕組みが無いので、1 分ごとに見に行く。窓が
 * 5 分あるため同じ枠が 5 回続けて条件を満たす。送信済みの鍵を持って弾く。
 *
 *     SLACK_WEBHOOK_URL='https://hooks.slack.com/...' node bot/notify.js
 *
 * 浴室ごとにチャンネルを分けるときは、共通の 1 本の代わりに SLACK_WEBHOOK_URL_TUB
 *（浴槽付き）と SLACK_WEBHOOK_URL_SHOWER（浴槽なし）を使う。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:8080";
const LEAD_MS = 5 * 60 * 1000;
const TICK_MS = 60 * 1000;

// 浴室の日本語名は API が返さないため、ここに持つ。src/config.js の写しなので、
// 食い違っていないことを test/notify.test.js が確かめる。
export const ROOM_LABELS = { shower: "風呂", tub: "風呂（浴槽付き）" };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SENT_PATH = path.join(HERE, "sent.json");
const USERS_PATH = path.join(HERE, "slack-users.json");

// --- 時刻 -----------------------------------------------------------------
// 日本は夏時間を持たないため +09:00 の固定オフセットとして計算してよい。

const JST_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** epoch ミリ秒が JST で属する暦日。"YYYY-MM-DD"。 */
const jstDay = (ms) => new Date(ms + JST_MS).toISOString().slice(0, 10);

/**
 * 滞在の「今日」。夜の枠は 25:00（翌 01:00）まで伸び、開始した夜の日付に属する。
 * 05:00 より前は前夜の続きとして扱う。src/slots.js の stayDate と同じ規則。
 */
function stayDay(ms) {
  const hour = new Date(ms + JST_MS).getUTCHours();
  return jstDay(hour < 5 ? ms - DAY_MS : ms);
}

const nextDay = (day) => jstDay(Date.parse(`${day}T00:00:00+09:00`) + DAY_MS);

// --- 通知対象を選ぶ -------------------------------------------------------

/**
 * 通知すべき枠を返す。API の応答・現在時刻・送信済みの鍵だけを見て、外に触らない。
 * 現在時刻を引数で受け取るのは、テストで時刻を動かせるようにするため。
 *
 * 鍵に reservation_id を使わない理由は、SQLite が削除された id を再利用するため。
 * 取り消しは DELETE なので、通知済みの予約が消えたあと別の予約が同じ id を得ると、
 * その人への通知が飛ばなくなる。日付・浴室・時刻・人の 4 つ組なら起きない。
 */
export function due(days, now, sent) {
  const found = [];
  for (const day of days) {
    for (const section of day.sections) {
      for (const room of section.rooms) {
        for (const slot of room.slots) {
          if (slot.state !== "taken") continue;
          // 開始済み（left <= 0）を弾くのはここ。予約済みの枠は過ぎても taken のまま。
          const left = Date.parse(slot.starts_at) - now;
          if (left <= 0 || left > LEAD_MS) continue;
          const key = [day.date, room.room, slot.slot, slot.member_id].join("|");
          if (sent.has(key)) continue;
          found.push({ key, name: slot.name, room: room.room, slot: slot.slot });
        }
      }
    }
  }
  return found;
}

/** 対応表に無い人は平文で出す。通知は飛ばないが投稿は落とさない。 */
export function message(entry, users) {
  const id = users[entry.name];
  const who = id ? `<@${id}>` : `${entry.name}さん`;
  return `${who} あと5分で ${ROOM_LABELS[entry.room] ?? entry.room} ${entry.slot} です`;
}

/**
 * その浴室の投稿先。浴室ごとに Slack のチャンネルが分かれているため、Webhook も浴室ごとに
 * 持つ。Incoming Webhook は 1 本が 1 チャンネルに固定されるため、投げ分けるには本数を
 * 分けるしかない。
 *
 * SLACK_WEBHOOK_URL_<TUB|SHOWER> を見て、無ければ共通の SLACK_WEBHOOK_URL に落ちる。
 * 1 チャンネルで済ませたいときは後者だけ設定すればよい。
 * Slack から貼ると <...> で囲まれることがあるので落とす。
 */
export function pickWebhook(room, env) {
  const raw = env[`SLACK_WEBHOOK_URL_${room.toUpperCase()}`] ?? env.SLACK_WEBHOOK_URL ?? "";
  return raw.trim().replace(/^<|>$/g, "");
}

// --- 外に触る部分 ---------------------------------------------------------

function readJson(file, fallback) {
  try {
    // Windows のエディタが付ける BOM を落とす。残っていると JSON.parse が失敗する。
    const text = fs.readFileSync(file, "utf8");
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return fallback;
  }
}

async function getJson(url) {
  const res = await fetch(url);
  // 期間外の日は 404 (not_in_period) が返る。異常ではないので黙って飛ばす。
  return res.ok ? res.json() : null;
}

async function post(webhook, text) {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack ${res.status} ${await res.text()}`);
}

async function tick(sent) {
  const now = Date.now();
  const today = stayDay(now);
  const days = (await Promise.all(
    [today, nextDay(today)].map((day) => getJson(`${API_BASE}/api/v1/bath/${day}`)),
  )).filter((day) => day !== null);

  // 毎回読み直す。動かしながら対応表を埋めていけるようにするため。
  const users = readJson(USERS_PATH, {});

  for (const entry of due(days, now, sent)) {
    try {
      await post(pickWebhook(entry.room, process.env), message(entry, users));
      // 成功した鍵だけ記録する。失敗したものは窓が続く間に自然と再試行される。
      sent.add(entry.key);
      fs.writeFileSync(SENT_PATH, JSON.stringify([...sent]));
      console.log(`送信: ${entry.key}`);
    } catch (error) {
      console.error(`送信に失敗: ${entry.key}`, error.message);
    }
  }
}

/** 名簿にいて対応表に無い人を出す。名前を変えると対応表が黙って壊れるため。 */
async function warnUnmapped() {
  const users = readJson(USERS_PATH, {});
  const body = await getJson(`${API_BASE}/api/v1/members`);
  if (body === null) return;
  const missing = body.members.filter((m) => !users[m.name]).map((m) => m.name);
  if (missing.length > 0) console.warn(`対応表に無い: ${missing.join(", ")}`);
}

async function main() {
  // 投稿先の形は起動時に確かめる。送信の瞬間まで誤りに気づけないと、原因を追いにくい。
  const rooms = Object.keys(ROOM_LABELS);
  const blank = rooms.filter((room) => !pickWebhook(room, process.env).startsWith("http"));
  if (blank.length > 0) {
    console.error(`投稿先が URL になっていない浴室: ${blank.join(", ")}`);
    console.error("SLACK_WEBHOOK_URL_TUB / SLACK_WEBHOOK_URL_SHOWER か、共通の SLACK_WEBHOOK_URL を設定する");
    process.exit(1);
  }

  // 送信済みはファイルに残す。systemd の Restart=always があるため、落ちて再起動する
  // たびに記憶を失うと、窓の中の枠へ投稿し続ける状態に入り得る。
  const sent = new Set(readJson(SENT_PATH, []));
  console.log(`kominka-bot 起動  API=${API_BASE}  送信済み=${sent.size}件`);
  await warnUnmapped().catch((error) => console.error("名簿の確認に失敗", error.message));

  // 例外でループごと死なせない。アプリが落ちている間も次の分で復帰する。
  const run = () => tick(sent).catch((error) => console.error("巡回に失敗", error.message));
  await run();
  setInterval(run, TICK_MS);
}

// import されたとき（テスト）は動かさない。直接実行したときだけ常駐する。
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
