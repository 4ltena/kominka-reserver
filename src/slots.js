/** 風呂の枠と予約可否。現在時刻は引数で受け取り、データベースには触れない。 */

import * as config from "./config.js";
import * as jst from "./jst.js";

/** 枠の長さは浴室ごとに違うため、開始時刻の並びも浴室ごとに変わる。 */
export function slotStarts(section, room) {
  const [startHour, endHour] = config.SECTION_HOURS[section];
  const step = config.ROOM_SLOT_MINUTES[room];

  const override = config.SECTION_LAST_START[section];
  let limit;
  if (override !== undefined) {
    const [hour, minute] = override.split(":").map(Number);
    limit = hour * 60 + minute;
  } else {
    // 指定が無ければ、枠が区分の終了時刻をはみ出さない最後の開始。
    limit = endHour * 60 - step;
  }

  const starts = [];
  for (let minute = startHour * 60; minute <= limit; minute += step) {
    starts.push(`${jst.pad(Math.floor(minute / 60))}:${jst.pad(minute % 60)}`);
  }
  return starts;
}

export function sectionInPeriod(section, day) {
  const [first, last] = config.PERIOD.bath[section];
  return first <= day && day <= last;
}

export function sectionsForDate(day) {
  return config.SECTIONS.filter((section) => sectionInPeriod(section, day));
}

/** "24:00" は翌日の 00:00 を指す。夜の最終枠がこの形になる。 */
export function slotInstant(day, slot) {
  return jst.instantAt(day, slot);
}

/** 深夜は前夜の続きとして扱う。夜の枠が翌 01:20 まで伸びるため。 */
export function stayDate(now) {
  const today = jst.dayOf(now);
  return jst.hourOf(now) < config.DAY_CHANGE_HOUR ? jst.addDays(today, -1) : today;
}

export function selectableDates(now) {
  const today = stayDate(now);
  return [today, jst.addDays(today, 1)].filter((day) => sectionsForDate(day).length > 0);
}

/** その日にまだ始まっていない枠が 1 つでもあるか。 */
export function hasOpenSlot(day, now) {
  return sectionsForDate(day).some((section) =>
    config.ROOMS.some((room) =>
      slotStarts(section, room).some((slot) => slotInstant(day, slot) > now),
    ),
  );
}

/** 予約できるなら "ok"、できないなら理由を返す。 */
export function checkReservable(day, section, room, slot, now) {
  if (!config.SECTIONS.includes(section) || !config.ROOMS.includes(room)) return "bad_slot";
  if (!slotStarts(section, room).includes(slot)) return "bad_slot";
  if (!sectionInPeriod(section, day)) return "out_of_period";
  const today = stayDate(now);
  if (day !== today && day !== jst.addDays(today, 1)) return "not_selectable_date";
  if (slotInstant(day, slot) <= now) return "past";
  return "ok";
}

export function formatDay(day) {
  const { month, day: date } = jst.parts(day);
  return `${month}/${date}(${config.WEEKDAYS[jst.weekday(day)]})`;
}
