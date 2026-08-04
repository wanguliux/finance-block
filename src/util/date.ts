/**
 * 本地时区日期工具
 *
 * 为什么不用 toISOString()？
 * `new Date().toISOString()` 返回的是 UTC 时间，中国用户（UTC+8）在凌晨 0–8 点
 * 调用会得到"昨天"的日期字符串，导致流水/预算/热力图/结转的"今天"与周期边界
 * 偏移一天。所有面向用户展示的日期都应使用本地时区，统一走这里。
 */

/** 取本地时区今天的 YYYY-MM-DD */
export function todayLocal(): string {
  return localDateString(new Date());
}

/** 把 Date 格式化为本地时区的 YYYY-MM-DD（不走 UTC） */
export function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 今天往前推 n 天的本地 YYYY-MM-DD（n=0 即今天） */
export function daysAgoLocal(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateString(d);
}

/** YYYY-MM-DD 严格匹配（不校验月份天数上限，交给 Date 归一） */
const DATE_STR_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 判断字符串是否为合法的 YYYY-MM-DD */
export function isDateStr(s: string): boolean {
  return DATE_STR_RE.test(s.trim());
}

/**
 * 以任意锚点日为基准往前推 n 天（n=0 即锚点当天）。
 *
 * 为什么不复用 daysAgoLocal：finance-log 的 `date` 参数允许把窗口锚在历史某天，
 * 此时基准不再是「今天」。用 `new Date(y, m-1, d)` 构造本地时间，避免
 * `new Date('2026-07-15')` 被当作 UTC 解析导致东八区回退一天。
 *
 * 非法锚点原样返回，由调用方决定是否降级。
 */
export function daysBefore(anchor: string, n: number): string {
  const m = DATE_STR_RE.exec(anchor.trim());
  if (!m) return anchor;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() - n);
  return localDateString(d);
}

/**
 * 由生日推导「截至某日期」的周岁年龄。
 *
 * 规则：未到当年生日当天，算上一年（出生当年生日当天记 0 岁）。
 * 例：生日 1996-05-20，截至 2026-05-19 → 29 岁；2026-05-20 → 30 岁。
 *
 * 供两处使用：
 * ① ficalc「当前年龄」从生日按今天推导（设置了 config.birthday 时 age 参数可不填）；
 * ② 设置了触发日期（LifeEventDef.date）的人生事件，由「日期 + 生日」推导触发年龄。
 *
 * @returns 年龄（0–120）；birthday 或 at 非法、或参照日早于出生日（未出生）时返回 null
 */
export function ageFromBirthday(birthday: string, at: string): number | null {
  const bm = DATE_STR_RE.exec(birthday.trim());
  const am = DATE_STR_RE.exec(at.trim());
  if (!bm || !am) return null;

  const by = Number(bm[1]);
  const bmo = Number(bm[2]);
  const bd = Number(bm[3]);
  const ay = Number(am[1]);
  const amo = Number(am[2]);
  const ad = Number(am[3]);

  // 日期合法性兜底：月份 1–12、日期 1–31（日月上限交给 Date 归一）
  if (bmo < 1 || bmo > 12 || amo < 1 || amo > 12) return null;
  if (bd < 1 || bd > 31 || ad < 1 || ad > 31) return null;

  // 参照日早于出生日（未出生）→ 不可能，返回 null
  if (ay < by) return null;
  if (ay === by && (amo < bmo || (amo === bmo && ad < bd))) return null;

  let age = ay - by;
  // 未过今年生日 → 减一岁
  if (amo < bmo || (amo === bmo && ad < bd)) age -= 1;
  return Math.max(0, Math.min(120, age));
}
