/**
 * Slack bot などの外部プログラム向けの JSON API。
 *
 * 画面と同じ規則で動く。締切や枠の判定は slots.js と meals.js に任せ、
 * 先着順と 1 人 1 枠は db.js の一意制約が守る。ここは入出力の変換だけを担う。
 *
 * 失敗は HTTP の状態コードと機械可読な error 文字列で返す。画面側の日本語文言
 * とは分離してあるので、文面を変えても bot は壊れない。
 */

import express from "express";

import { clock } from "./clock.js";
import * as config from "./config.js";
import * as db from "./db.js";
import * as jst from "./jst.js";
import * as meals from "./meals.js";
import * as slots from "./slots.js";

export const PREFIX = "/api/v1";

// 拒否理由と HTTP 状態コードの対応。
export const STATUS = {
  bad_request: 400,
  bad_slot: 400,
  bad_size: 400,
  unknown_member: 404,
  unknown_meal: 404,
  unknown_reservation: 404,
  not_in_period: 404,
  not_found: 404,
  method_not_allowed: 405,
  not_selectable_date: 409,
  slot_started: 409,
  slot_taken: 409,
  already_has: 409,
  deadline_passed: 409,
  server_error: 500,
};

const TRUE_WORDS = ["1", "true", "yes", "on"];

function fail(res, code, extra = {}) {
  return res.status(STATUS[code] ?? 400).json({ error: code, ...extra });
}

/** JSON 本体、フォーム、クエリ文字列のどれで渡されても受ける。 */
function param(req, name) {
  const body = req.body;
  if (body !== null && typeof body === "object" && !Array.isArray(body) && name in body) {
    const value = body[name];
    // フォームの空欄は「渡していない」とみなし、クエリ文字列に譲る。
    if (req.is("application/json") || (value !== "" && value !== undefined)) return value;
  }
  const query = req.query[name];
  return query === undefined || query === "" ? null : query;
}

function flag(req, name) {
  const value = param(req, name);
  return value !== null && TRUE_WORDS.includes(String(value).toLowerCase());
}

function memberId(req) {
  const raw = param(req, "member_id");
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : null;
  if (typeof raw === "string" && /^[+-]?\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

/** member_id を受け取れなかった理由を分けて返す。 */
function noMemberId(req, res) {
  const raw = param(req, "member_id");
  const detail = raw === null || raw === undefined ? "member_id が要る" : "member_id は整数で渡す";
  return fail(res, "bad_request", { detail });
}

export function createApiRouter(database) {
  // Flask と同じく、末尾のスラッシュが余分な経路は別物として 404 にする。
  const router = express.Router({ strict: true });
  router.use(express.json({ limit: "64kb" }));
  router.use(express.urlencoded({ extended: false, limit: "64kb" }));

  const methodNotAllowed = (req, res) => fail(res, "method_not_allowed", { detail: "method が違う" });

  // --- 名簿 ---------------------------------------------------------------

  router
    .route("/members")
    .get((req, res) => {
      const rows = db.listMembers(database);
      res.json({
        members: rows.map((row) => ({ id: row.id, name: row.name })),
        registered: rows.length,
      });
    })
    .all(methodNotAllowed);

  // --- 食事 ---------------------------------------------------------------

  function mealJson(meal, now) {
    const { people, total } = db.riceSummary(database, meal.day, meal.kind);
    return {
      date: meal.day,
      meal: meal.kind,
      state: meals.voteState(meal, now),
      deadline: jst.iso(meals.voteDeadline(meal)),
      go: total,
      people,
      registered: db.countActiveMembers(database),
      by_size: db.riceBySize(database, meal.day, meal.kind),
    };
  }

  /** 経路の日付と種類を食事にする。期間外や書式違いは null。 */
  function mealOf(req) {
    const day = jst.parseDay(req.params.day);
    const kind = req.params.kind;
    if (day === null || !config.MEALS.includes(kind) || !meals.mealInPeriod(kind, day)) return null;
    return { day, kind };
  }

  router
    .route("/meals")
    .get((req, res) => {
      // 既定は画面と同じ直近 4 件。?all=true で期間内の全食事。
      const now = clock.now();
      const wanted = flag(req, "all") ? meals.allMeals() : meals.visibleMeals(now);
      res.json({ now: jst.iso(now), meals: wanted.map((meal) => mealJson(meal, now)) });
    })
    .all(methodNotAllowed);

  router
    .route("/meals/:day/:kind")
    .get((req, res) => {
      const meal = mealOf(req);
      if (meal === null) return fail(res, "unknown_meal");
      return res.json(mealJson(meal, clock.now()));
    })
    .all(methodNotAllowed);

  router
    .route("/meals/:day/:kind/vote")
    .post((req, res) => {
      const meal = mealOf(req);
      if (meal === null) return fail(res, "unknown_meal");

      const member = memberId(req);
      if (member === null) return noMemberId(req, res);
      if (db.getMember(database, member) === null) return fail(res, "unknown_member");

      const size = param(req, "size");
      if (!config.RICE_SIZES.includes(size)) {
        return fail(res, "bad_size", { allowed: config.RICE_SIZES });
      }

      const now = clock.now();
      if (meals.voteState(meal, now) !== "open") {
        return fail(res, "deadline_passed", { deadline: jst.iso(meals.voteDeadline(meal)) });
      }

      db.vote(database, meal.day, meal.kind, member, size);
      return res.json(mealJson(meal, now));
    })
    // 挙手していなくても成功として返す。取り消しは何度呼んでも同じ。
    .delete((req, res) => {
      const meal = mealOf(req);
      if (meal === null) return fail(res, "unknown_meal");

      const member = memberId(req);
      if (member === null) return noMemberId(req, res);

      const now = clock.now();
      if (meals.voteState(meal, now) !== "open") {
        return fail(res, "deadline_passed", { deadline: jst.iso(meals.voteDeadline(meal)) });
      }

      db.unvote(database, meal.day, meal.kind, member);
      return res.json(mealJson(meal, now));
    })
    .all(methodNotAllowed);

  // --- 風呂 ---------------------------------------------------------------

  router
    .route("/bath/reservations/:id")
    .delete((req, res) => {
      if (!/^\d+$/.test(req.params.id)) return fail(res, "not_found", { detail: "予約の番号が整数ではない" });
      const member = memberId(req);
      if (member === null) return noMemberId(req, res);
      if (!db.cancelReservation(database, Number(req.params.id), member)) {
        return fail(res, "unknown_reservation");
      }
      return res.json({ cancelled: Number(req.params.id) });
    })
    .all(methodNotAllowed);

  router
    .route("/bath/:day")
    .get((req, res) => {
      const day = jst.parseDay(req.params.day);
      if (day === null) return fail(res, "bad_request", { detail: "date は YYYY-MM-DD" });

      const now = clock.now();
      const sections = slots.sectionsForDate(day);
      if (sections.length === 0) return fail(res, "not_in_period");

      // 期間内でも、今日と明日以外はまだ受け付けない。空き表示だけを見て予約に
      // 進むと拒否されるため、枠ごとに可否を持たせる。
      const selectable = slots.selectableDates(now).includes(day);
      const reserved = db.reservationsForDate(database, day);

      const out = sections.map((section) => ({
        section,
        rooms: config.ROOMS.map((room) => ({
          room,
          minutes: config.ROOM_SLOT_MINUTES[room],
          slots: slots.slotStarts(section, room).map((slot) => {
            const row = reserved.get(db.slotKey(room, slot));
            const startsAt = slots.slotInstant(day, slot);
            const state = row !== undefined ? "taken" : startsAt <= now ? "past" : "free";
            return {
              slot,
              starts_at: jst.iso(startsAt),
              state,
              reservable: selectable && state === "free",
              member_id: row?.member_id ?? null,
              name: row?.name ?? null,
              reservation_id: row?.id ?? null,
            };
          }),
        })),
      }));

      return res.json({ date: day, now: jst.iso(now), selectable, sections: out });
    })
    .all(methodNotAllowed);

  router
    .route("/bath/:day/reserve")
    .post((req, res) => {
      const day = jst.parseDay(req.params.day);
      if (day === null) return fail(res, "bad_request", { detail: "date は YYYY-MM-DD" });

      const member = memberId(req);
      if (member === null) return noMemberId(req, res);
      if (db.getMember(database, member) === null) return fail(res, "unknown_member");

      const section = param(req, "section") ?? "";
      const room = param(req, "room") ?? "";
      const slot = param(req, "slot") ?? "";
      if (!config.ROOMS.includes(room)) return fail(res, "bad_slot", { allowed: config.ROOMS });

      const reason = slots.checkReservable(day, section, room, slot, clock.now());
      if (reason === "past") return fail(res, "slot_started");
      if (reason === "out_of_period") return fail(res, "not_in_period");
      if (reason !== "ok") return fail(res, reason);

      const result = db.reserve(database, day, section, room, slot, member);
      if (result === "already_has") {
        const held = db.memberReservation(database, day, section, member);
        return fail(res, "already_has", {
          held: {
            reservation_id: held.id,
            room: held.room,
            slot: held.slot,
            section: held.section,
          },
        });
      }
      if (result === "slot_taken") return fail(res, "slot_taken");

      const row = db.reservationsForDate(database, day).get(db.slotKey(room, slot));
      return res.status(201).json({
        reservation_id: row.id,
        date: day,
        section,
        room,
        slot,
        starts_at: jst.iso(slots.slotInstant(day, slot)),
        member_id: member,
        name: row.name,
      });
    })
    .all(methodNotAllowed);

  // --- 経路の間違いと想定外 -------------------------------------------------

  // API の経路では、Flask の既定のような HTML ではなく JSON を返す。HTML が返ると
  // 呼ぶ側の JSON 解釈が例外で落ち、原因が分からないまま止まる。
  router.use((req, res) => fail(res, "not_found", { detail: "知らない経路" }));

  router.use((error, req, res, next) => {
    if (error?.type === "entity.parse.failed") {
      return fail(res, "bad_request", { detail: "JSON として解釈できない" });
    }
    if (error?.type === "entity.too.large") {
      return fail(res, "bad_request", { detail: "本体が大きすぎる" });
    }
    console.error(error);
    return fail(res, "server_error", { detail: "内部で失敗した" });
  });

  return router;
}
