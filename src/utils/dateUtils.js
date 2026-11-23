/**
 * Bangladesh (Asia/Dhaka, UTC+6) Date & Working-Day Utilities
 * PostgreSQL stores dates at Bangladesh midnight (T18:00:00.000Z of prior UTC day).
 * All business date comparisons must be performed in Asia/Dhaka calendar dates.
 */

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

/**
 * Converts a Date or ISO timestamp into a YYYY-MM-DD string in Asia/Dhaka (UTC+6).
 * If already a YYYY-MM-DD string, returns it unchanged.
 */
function toDhakaDateStr(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const shifted = new Date(d.getTime() + DHAKA_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Parses a YYYY-MM-DD string as a pure UTC midnight Date for safe calendar arithmetic.
 */
function parseDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatUtcDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Adds (or subtracts) calendar months to a YYYY-MM-DD string, clamping day to month end.
 */
function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const targetFirst = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const clampedDay = Math.min(d, lastDay);
  return formatUtcDate(
    new Date(Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth(), clampedDay))
  );
}

/**
 * Adds (or subtracts) calendar years to a YYYY-MM-DD string.
 */
function addYears(dateStr, years) {
  return addMonths(dateStr, years * 12);
}

/**
 * Returns calendar day difference: (laterDateStr - earlierDateStr) in whole days.
 */
function diffDays(earlierDateStr, laterDateStr) {
  const a = parseDateStr(earlierDateStr);
  const b = parseDateStr(laterDateStr);
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Returns YYYY-MM for a YYYY-MM-DD string.
 */
function yearMonth(dateStr) {
  return dateStr.slice(0, 7);
}

/**
 * Checks whether a YYYY-MM-DD date falls within the last N working days of its month.
 * Bangladesh standard workweek: Sunday (0) through Thursday (4) are working days;
 * Friday (5) and Saturday (6) are weekend days.
 */
function isInLastWorkingDaysOfMonth(dateStr, count = 3) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const lastDayOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const workingDaysFromEnd = [];
  for (let day = lastDayOfMonth; day >= 1 && workingDaysFromEnd.length < count; day--) {
    const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
    if (dow !== 5 && dow !== 6) {
      workingDaysFromEnd.push(day);
    }
  }

  if (workingDaysFromEnd.length === 0) return false;
  const earliestLastWorkingDay = Math.min(...workingDaysFromEnd);
  return d >= earliestLastWorkingDay;
}

module.exports = {
  toDhakaDateStr,
  parseDateStr,
  addMonths,
  addYears,
  diffDays,
  yearMonth,
  isInLastWorkingDaysOfMonth
};
