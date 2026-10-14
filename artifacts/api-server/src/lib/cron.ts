// Minimal 5-field cron calculator: minute hour day-of-month month day-of-week.
// Supports "*", lists, ranges "a-b", and steps "*/n" or "a-b/n". Day-of-week runs 0-6
// with 7 accepted as Sunday. Both day fields restricted follows standard cron
// "match either" semantics.

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step in "${part}".`);
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      start = a;
      end = b;
    } else {
      start = Number(rangePart);
      end = stepPart === undefined ? start : max;
    }
    if (
      !Number.isInteger(start) || !Number.isInteger(end) ||
      start < min || end > max || start > end
    ) {
      throw new Error(`Invalid cron field "${part}".`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

export function nextRun(expression: string, from: Date = new Date()): Date {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron expression: "${expression}". Expected 5 fields.`);
  const [minuteField, hourField, domField, monthField, dowField] = fields;
  const minutes = parseField(minuteField, 0, 59);
  const hours = parseField(hourField, 0, 23);
  const daysOfMonth = parseField(domField, 1, 31);
  const months = parseField(monthField, 1, 12);
  const daysOfWeek = parseField(dowField, 0, 7).map((value) => (value === 7 ? 0 : value));
  const domRestricted = domField !== "*";
  const dowRestricted = dowField !== "*";

  const dayMatches = (candidate: Date): boolean => {
    const domOk = daysOfMonth.includes(candidate.getDate());
    const dowOk = daysOfWeek.includes(candidate.getDay());
    if (domRestricted && dowRestricted) return domOk || dowOk;
    if (domRestricted) return domOk;
    if (dowRestricted) return dowOk;
    return true;
  };

  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (
      minutes.includes(candidate.getMinutes()) &&
      hours.includes(candidate.getHours()) &&
      months.includes(candidate.getMonth() + 1) &&
      dayMatches(candidate)
    ) {
      return new Date(candidate.getTime());
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error(`Cron expression "${expression}" does not fire within a year.`);
}
