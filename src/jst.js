/**
 * 日本標準時だけを扱う時刻の道具。
 *
 * 日本は 1951 年を最後に夏時間を持たない。そのため +09:00 の固定オフセットとして
 * 計算してよく、タイムゾーンのデータベースを引く必要がない。
 *
 * 暦日は "YYYY-MM-DD" の文字列で持つ。データベースの格納形と同じにすることで変換の
 * 往復が減り、Date の壁時計計算に頼らずに済む。ISO の日付は辞書順が日付順なので、
 * 前後の比較も文字列のまま行える。瞬間は epoch ミリ秒の数値で持つ。
 *
 * Date を直接触るのはこのファイルだけにする。
 */

const OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const pad = (value) => String(value).padStart(2, "0");

/** epoch ミリ秒を、UTC として読んだ暦日にする。内部でだけ使う。 */
function dayFromUTC(ms) {
  const point = new Date(ms);
  return [
    point.getUTCFullYear(),
    pad(point.getUTCMonth() + 1),
    pad(point.getUTCDate()),
  ].join("-");
}

function split(day) {
  const found = DAY_PATTERN.exec(day);
  if (found === null) throw new TypeError(`暦日ではない: ${day}`);
  return [Number(found[1]), Number(found[2]), Number(found[3])];
}

/** "YYYY-MM-DD" として妥当ならそのまま返し、そうでなければ null。 */
export function parseDay(raw) {
  if (typeof raw !== "string" || DAY_PATTERN.exec(raw) === null) return null;
  const [year, month, day] = split(raw);
  // 2026-02-30 のような日付は Date.UTC が繰り上げてしまう。往復させて弾く。
  return dayFromUTC(Date.UTC(year, month - 1, day)) === raw ? raw : null;
}

/** 暦日と JST の時刻から瞬間を作る。hour は 24 以上でもよく、その分だけ翌日を指す。 */
export function instant(day, hour, minute = 0) {
  const [year, month, date] = split(day);
  return Date.UTC(year, month - 1, date, hour - 9, minute);
}

/** "HH:MM" から瞬間を作る。"25:00" は翌 01:00 になる。 */
export function instantAt(day, clockTime) {
  const [hour, minute] = clockTime.split(":").map(Number);
  return instant(day, hour, minute);
}

/** その瞬間が JST で属する暦日。 */
export function dayOf(ms) {
  return dayFromUTC(ms + OFFSET_MS);
}

/** その瞬間の JST での時。0 から 23。 */
export function hourOf(ms) {
  return new Date(ms + OFFSET_MS).getUTCHours();
}

export function addDays(day, count) {
  const [year, month, date] = split(day);
  return dayFromUTC(Date.UTC(year, month - 1, date + count));
}

/** Python の date.weekday() に合わせ、月曜を 0 とする。 */
export function weekday(day) {
  const [year, month, date] = split(day);
  return (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7;
}

/** "2026-08-20T19:00:00+09:00"。datetime.isoformat() と同じ形。 */
export function iso(ms) {
  return `${new Date(ms + OFFSET_MS).toISOString().slice(0, 19)}+09:00`;
}

export function parts(day) {
  const [year, month, date] = split(day);
  return { year, month, day: date };
}

/** 締切の表示に使う "8/21 22:00"。 */
export function formatClock(ms) {
  const point = new Date(ms + OFFSET_MS);
  const date = `${point.getUTCMonth() + 1}/${point.getUTCDate()}`;
  return `${date} ${pad(point.getUTCHours())}:${pad(point.getUTCMinutes())}`;
}
