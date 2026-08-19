/**
 * 画面のルーティング。
 *
 * 操作はすべて通常のフォーム送信で行い、書き込み後は転送して再送信を防ぐ。
 * JavaScript を切っていても予約と投票ができる。
 */

import path from "node:path";

import ejs from "ejs";
import express from "express";

import { clock } from "./clock.js";
import * as config from "./config.js";
import * as db from "./db.js";
import * as jst from "./jst.js";
import * as meals from "./meals.js";
import * as slots from "./slots.js";

const COOKIE = "member_id";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30 * 1000;
const NOTICE = "notice";
const NOTICE_MAX_AGE = 10 * 1000;

/**
 * 転送をまたいで出す短い知らせ。
 *
 * Flask の flash は署名付きの session に載せていた。ここでは合図だけを cookie に
 * 置き、文面はサーバ側の表から引く。利用者が cookie を書き換えても、表に無い合図
 * は捨てられるので任意の文字列は画面に出せない。
 */
const NOTICES = {
  slot_taken: "この枠はちょうど埋まりました。",
  past: "その枠は始まっています。",
  out_of_period: "その日は予約できません。",
  not_selectable_date: "その日は予約できません。",
  bad_slot: "その枠は選べません。",
  pick_name: "名前を選んでください。",
  not_yours: "他の人の予約は取り消せません。",
  closed: "受付時間外です。",
};

const view = (name) => path.join(config.VIEW_DIR, `${name}.ejs`);

/** 0.5 刻みなので、整数のときは小数点を落とす。 */
export const formatGo = (total) => String(total);

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      // 壊れた cookie は無かったことにする。
    }
  }
  return out;
}

/** cookie の合図を文面にする。読めない合図は null。 */
function readNotice(raw) {
  if (!raw) return null;
  if (raw in NOTICES) return NOTICES[raw];

  // 時刻そのものが : を含むため、区切りでは分解せず形ごと照合する。
  const found = /^already_has:([a-z]+):([a-z]+):(\d{2}:\d{2})$/.exec(raw);
  if (found === null) return null;
  const [, section, room, slot] = found;
  if (!config.SECTIONS.includes(section) || !config.ROOMS.includes(room)) return null;
  return (
    `${config.SECTION_LABELS[section]}の枠は ${slot} の` +
    `${config.ROOM_LABELS[room]}を予約済みです。取り消してから選んでください。`
  );
}

const setNotice = (res, code, cookiePath) =>
  res.cookie(NOTICE, code, { maxAge: NOTICE_MAX_AGE, sameSite: "lax", path: cookiePath });

export function createWebRouter(database, basePath = "") {
  const router = express.Router({ strict: true });

  // 自分がぶら下がっている位置を付けた行き先。転送も画面の中のリンクもこれを通す。
  const u = (path) => `${basePath}${path}`;
  const cookiePath = basePath === "" ? "/" : basePath;
  const flash = (res, code) => setNotice(res, code, cookiePath);
  router.use(express.urlencoded({ extended: false, limit: "64kb" }));

  // --- 補助 ---------------------------------------------------------------

  function currentMember(req) {
    const raw = readCookies(req)[COOKIE];
    if (!raw || !/^\d+$/.test(raw)) return null;
    return db.getMember(database, Number(raw));
  }

  async function page(req, res, name, locals) {
    const cookies = readCookies(req);
    const notice = readNotice(cookies[NOTICE]);
    if (cookies[NOTICE] !== undefined) res.clearCookie(NOTICE, { path: cookiePath });

    const data = {
      config,
      formatGo,
      base: basePath,
      member: currentMember(req),
      notice,
      tab: "",
      fragment: "",
      ...locals,
    };
    const body = await ejs.renderFile(view(name), data);
    res.type("html").send(await ejs.renderFile(view("base"), { ...data, body }));
  }

  const fragment = (res, name, locals) =>
    ejs
      .renderFile(view(name), { config, formatGo, base: basePath, ...locals })
      .then((html) => res.type("html").send(html));

  function defaultBathDate(now) {
    const selectable = slots.selectableDates(now);
    if (selectable.length === 0) return slots.stayDate(now);
    return selectable.find((day) => slots.hasOpenSlot(day, now)) ?? selectable[0];
  }

  function bathContext(day, now, member) {
    const reserved = db.reservationsForDate(database, day);
    const sections = slots.sectionsForDate(day).map((section) => ({
      key: section,
      label: config.SECTION_LABELS[section],
      columns: config.ROOMS.map((room) => ({
        room,
        label: config.ROOM_LABELS[room],
        minutes: config.ROOM_SLOT_MINUTES[room],
        rows: slots.slotStarts(section, room).map((slot) => {
          const row = reserved.get(db.slotKey(room, slot));
          if (row === undefined) {
            const started = slots.slotInstant(day, slot) <= now;
            return { slot, state: started ? "past" : "free", name: null, rid: null };
          }
          const mine = member !== null && row.member_id === member.id;
          return { slot, state: mine ? "mine" : "taken", name: row.name, rid: row.id };
        }),
      })),
    }));
    const tabs = slots.selectableDates(now).map((value) => ({
      value,
      label: slots.formatDay(value),
      current: value === day,
    }));
    return { day, dayValue: day, sections, tabs };
  }

  function mealsContext(now, member) {
    const registered = db.countActiveMembers(database);
    const cards = meals.visibleMeals(now).map((meal) => {
      const { people, total } = db.riceSummary(database, meal.day, meal.kind);
      return {
        day: meal.day,
        kind: meal.kind,
        title: meals.formatMeal(meal),
        state: meals.voteState(meal, now),
        closes: jst.formatClock(meals.voteDeadline(meal)),
        wanted: people,
        total: formatGo(total),
        registered,
        voted: member === null ? null : db.memberVote(database, meal.day, meal.kind, member.id),
      };
    });
    return { cards };
  }

  const askedDate = (req) => jst.parseDay(req.query.date ?? req.body?.date ?? "");

  // Flask は経路が別の method 用に登録されていれば 405 を返す。画面側もそれに揃える。
  const wrongMethod = (req, res) => res.status(405).type("text").send("method が違う");

  // --- 名前の選択 ---------------------------------------------------------

  router.route("/").get((req, res) => res.redirect(u("/bath"))).all(wrongMethod);

  router
    .route("/select")
    .get((req, res) => page(req, res, "select", { members: db.listMembers(database) }))
    .post((req, res) => {
      const raw = String(req.body.member_id ?? "");
      if (!/^\d+$/.test(raw) || db.getMember(database, Number(raw)) === null) {
        flash(res, "pick_name");
        return res.redirect(u("/select"));
      }
      res.cookie(COOKIE, raw, { maxAge: COOKIE_MAX_AGE, sameSite: "lax", path: cookiePath });
      return res.redirect(u("/bath"));
    })
    .all(wrongMethod);

  // --- 風呂 ---------------------------------------------------------------

  router.route("/bath").get((req, res) => {
    const member = currentMember(req);
    if (member === null) return res.redirect(u("/select"));
    const now = clock.now();
    const day = askedDate(req) ?? defaultBathDate(now);
    return page(req, res, "bath", {
      ...bathContext(day, now, member),
      tab: "bath",
      fragment: u(`/fragment/bath?date=${day}`),
    });
  }).all(wrongMethod);

  router.route("/fragment/bath").get((req, res) => {
    const now = clock.now();
    const day = askedDate(req) ?? defaultBathDate(now);
    return fragment(res, "_bath_table", bathContext(day, now, currentMember(req)));
  }).all(wrongMethod);

  router.route("/bath/reserve").post((req, res) => {
    const member = currentMember(req);
    if (member === null) return res.redirect(u("/select"));
    const now = clock.now();
    const day = askedDate(req);
    const section = String(req.body.section ?? "");
    const room = String(req.body.room ?? "");
    const slot = String(req.body.slot ?? "");

    if (day === null || !config.ROOMS.includes(room)) {
      flash(res, "bad_slot");
      return res.redirect(u("/bath"));
    }
    const reason = slots.checkReservable(day, section, room, slot, now);
    if (reason !== "ok") {
      flash(res, reason);
      return res.redirect(u(`/bath?date=${day}`));
    }
    const result = db.reserve(database, day, section, room, slot, member.id);
    if (result === "already_has") {
      const held = db.memberReservation(database, day, section, member.id);
      flash(res, `already_has:${section}:${held.room}:${held.slot}`);
    } else if (result === "slot_taken") {
      flash(res, "slot_taken");
    }
    return res.redirect(u(`/bath?date=${day}`));
  }).all(wrongMethod);

  router.route("/bath/cancel").post((req, res) => {
    const member = currentMember(req);
    if (member === null) return res.redirect(u("/select"));
    const raw = String(req.body.reservation_id ?? "");
    const day = askedDate(req);
    if (/^\d+$/.test(raw) && !db.cancelReservation(database, Number(raw), member.id)) {
      flash(res, "not_yours");
    }
    return res.redirect(u(day === null ? "/bath" : `/bath?date=${day}`));
  }).all(wrongMethod);

  // --- ごはん -------------------------------------------------------------

  router.route("/meals").get((req, res) => {
    const member = currentMember(req);
    if (member === null) return res.redirect(u("/select"));
    return page(req, res, "meals", {
      ...mealsContext(clock.now(), member),
      tab: "meals",
      fragment: u("/fragment/meals"),
    });
  }).all(wrongMethod);

  router
    .route("/fragment/meals")
    .get((req, res) => fragment(res, "_meal_cards", mealsContext(clock.now(), currentMember(req))))
    .all(wrongMethod);

  function mealFromForm(req) {
    const day = jst.parseDay(req.body.date ?? "");
    const kind = String(req.body.kind ?? "");
    if (day === null || !config.MEALS.includes(kind) || !meals.mealInPeriod(kind, day)) return null;
    return { day, kind };
  }

  router.route("/meals/vote").post((req, res) => {
    const member = currentMember(req);
    if (member === null) return res.redirect(u("/select"));
    const meal = mealFromForm(req);
    const size = String(req.body.size ?? "");
    if (!config.RICE_SIZES.includes(size)) {
      flash(res, "bad_slot");
    } else if (meal === null || meals.voteState(meal, clock.now()) !== "open") {
      flash(res, "closed");
    } else {
      db.vote(database, meal.day, meal.kind, member.id, size);
    }
    return res.redirect(u("/meals"));
  }).all(wrongMethod);

  router.route("/meals/unvote").post((req, res) => {
    const member = currentMember(req);
    if (member === null) return res.redirect(u("/select"));
    const meal = mealFromForm(req);
    if (meal === null || meals.voteState(meal, clock.now()) !== "open") {
      flash(res, "closed");
    } else {
      db.unvote(database, meal.day, meal.kind, member.id);
    }
    return res.redirect(u("/meals"));
  }).all(wrongMethod);

  // --- 名簿 ---------------------------------------------------------------

  router
    .route("/members")
    .get((req, res) => page(req, res, "members", { members: db.listMembers(database) }))
    .all(wrongMethod);

  return router;
}
