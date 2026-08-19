/** Node 版の純関数の出力を、tools/dump.py と同じ形で吐く。 */

import { createHash } from "node:crypto";

import * as config from "../src/config.js";
import * as jst from "../src/jst.js";
import * as meals from "../src/meals.js";
import * as slots from "../src/slots.js";

const FIRST = "2026-08-16";
const LAST = "2026-08-29";

function days() {
  const out = [];
  for (let day = FIRST; day <= LAST; day = jst.addDays(day, 1)) out.push(day);
  return out;
}

function grid(stepMinutes) {
  const out = [];
  const end = jst.instant("2026-08-29", 0);
  for (let now = jst.instant("2026-08-16", 0); now <= end; now += stepMinutes * 60_000) {
    out.push(now);
  }
  return out;
}

const lines = [];
const emit = (label, value) => lines.push(`${label}\t${value}`);

for (const section of config.SECTIONS) {
  for (const room of config.ROOMS) {
    emit(`slot_starts ${section} ${room}`, slots.slotStarts(section, room).join(","));
  }
}

for (const day of days()) {
  emit(`sections_for_date ${day}`, slots.sectionsForDate(day).join(","));
  emit(`format_day ${day}`, slots.formatDay(day));
}

for (const meal of meals.allMeals()) {
  emit(`meal ${meal.day} ${meal.kind}`, meals.formatMeal(meal));
  emit(`deadline ${meal.day} ${meal.kind}`, jst.iso(meals.voteDeadline(meal)));
}

for (const day of days()) {
  for (const section of config.SECTIONS) {
    for (const room of config.ROOMS) {
      for (const slot of slots.slotStarts(section, room)) {
        emit(`slot_datetime ${day} ${slot}`, jst.iso(slots.slotInstant(day, slot)));
      }
    }
  }
}

for (const now of grid(1)) {
  emit(`stay ${jst.iso(now)}`, `${slots.stayDate(now)}|${slots.selectableDates(now).join(",")}`);
}

for (const now of grid(30)) {
  const parts = [];
  for (const day of days()) {
    for (const section of config.SECTIONS) {
      for (const room of config.ROOMS) {
        for (const slot of slots.slotStarts(section, room)) {
          parts.push(slots.checkReservable(day, section, room, slot, now));
        }
      }
    }
    parts.push(slots.hasOpenSlot(day, now) ? "1" : "0");
  }
  for (const meal of meals.allMeals()) parts.push(meals.voteState(meal, now));
  parts.push(meals.visibleMeals(now).map((m) => `${m.day}${m.kind}`).join(","));
  emit(`digest ${jst.iso(now)}`, createHash("sha1").update(parts.join("|")).digest("hex"));
}

process.stdout.write(`${lines.join("\n")}\n`);
