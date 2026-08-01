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
