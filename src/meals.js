/** 食事の一覧と投票窓。現在時刻は引数で受け取り、データベースには触れない。 */

import * as config from "./config.js";
import * as jst from "./jst.js";

export function mealInPeriod(kind, day) {
  const [first, last] = config.PERIOD.meal[kind];
  return first <= day && day <= last;
}

/** 期間内の全食事を時系列で返す。締切の順と一致する。 */
export function allMeals() {
  const bounds = config.MEALS.map((kind) => config.PERIOD.meal[kind]);
  const first = bounds.map(([from]) => from).reduce((a, b) => (a < b ? a : b));
  const last = bounds.map(([, to]) => to).reduce((a, b) => (a > b ? a : b));

  const out = [];
  for (let day = first; day <= last; day = jst.addDays(day, 1)) {
    for (const kind of config.MEALS) {
      if (mealInPeriod(kind, day)) out.push({ day, kind });
    }
  }
  return out;
}

export function voteDeadline(meal) {
  const [shift, closeHour] = config.VOTE_DEADLINE[meal.kind];
  return jst.instant(jst.addDays(meal.day, shift), closeHour);
}

/** 受付開始は設けない。締切まではいつでも挙手できる。 */
export function voteState(meal, now) {
  return now < voteDeadline(meal) ? "open" : "closed";
}

/** 締切が未来の先頭 3 件と、直近で締め切った 1 件。 */
export function visibleMeals(now) {
  const meals = allMeals();
  const closed = meals.filter((meal) => voteState(meal, now) === "closed");
  const upcoming = meals.filter((meal) => voteState(meal, now) !== "closed");
  return [...closed.slice(-1), ...upcoming.slice(0, 3)];
}

export function formatMeal(meal) {
  const { month, day } = jst.parts(meal.day);
  const weekday = config.WEEKDAYS[jst.weekday(meal.day)];
  return `${month}/${day}(${weekday}) ${config.MEAL_LABELS[meal.kind]}`;
}
