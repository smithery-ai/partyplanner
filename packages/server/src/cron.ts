// Minimal POSIX cron-expression matcher.
//
// Five fields: minute, hour, day-of-month, month, day-of-week.
// Each field supports `*`, `*/N`, `a-b`, `a,b,c`, plain integers, and
// combinations thereof. All evaluation is in UTC. Day-of-week is 0-6 with 0/7
// = Sunday, matching standard cron.
//
// We intentionally do not implement extensions like `@daily`, special tokens
// (`L`, `W`, `?`), or seconds. The dispatcher granularity is one minute, so
// matching against the current minute is sufficient.

const FIELD_RANGES: Array<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day-of-month
  [1, 12], // month
  [0, 7], // day-of-week (0 and 7 both = Sunday)
];

type ParsedField = number[] | "any";

export type ParsedCron = {
  minute: ParsedField;
  hour: ParsedField;
  dayOfMonth: ParsedField;
  month: ParsedField;
  dayOfWeek: ParsedField;
};

export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron must have 5 fields (minute hour dom month dow), got ${parts.length}: ${JSON.stringify(expression)}`,
    );
  }
  return {
    minute: parseField(parts[0], FIELD_RANGES[0]),
    hour: parseField(parts[1], FIELD_RANGES[1]),
    dayOfMonth: parseField(parts[2], FIELD_RANGES[2]),
    month: parseField(parts[3], FIELD_RANGES[3]),
    dayOfWeek: parseField(parts[4], FIELD_RANGES[4]),
  };
}

function parseField(
  raw: string,
  [lo, hi]: readonly [number, number],
): ParsedField {
  if (raw === "*") return "any";
  const out = new Set<number>();
  for (const piece of raw.split(",")) {
    const stepIndex = piece.indexOf("/");
    let base = piece;
    let step = 1;
    if (stepIndex >= 0) {
      step = Number.parseInt(piece.slice(stepIndex + 1), 10);
      base = piece.slice(0, stepIndex);
      if (!Number.isFinite(step) || step < 1) {
        throw new Error(`invalid step in cron field: ${piece}`);
      }
    }
    let from = lo;
    let to = hi;
    if (base !== "*" && base !== "") {
      const range = base.split("-");
      if (range.length === 1) {
        from = to = Number.parseInt(range[0], 10);
      } else if (range.length === 2) {
        from = Number.parseInt(range[0], 10);
        to = Number.parseInt(range[1], 10);
      } else {
        throw new Error(`invalid cron range: ${piece}`);
      }
    }
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from < lo ||
      to > hi ||
      from > to
    ) {
      throw new Error(
        `cron field out of range [${lo},${hi}]: ${JSON.stringify(piece)}`,
      );
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function cronMatches(parsed: ParsedCron, at: Date): boolean {
  const minute = at.getUTCMinutes();
  const hour = at.getUTCHours();
  const day = at.getUTCDate();
  const month = at.getUTCMonth() + 1;
  const dow = at.getUTCDay();
  return (
    matches(parsed.minute, minute) &&
    matches(parsed.hour, hour) &&
    matches(parsed.dayOfMonth, day) &&
    matches(parsed.month, month) &&
    (matches(parsed.dayOfWeek, dow) ||
      matches(parsed.dayOfWeek, dow === 0 ? 7 : dow))
  );
}

function matches(field: ParsedField, value: number): boolean {
  return field === "any" || field.includes(value);
}
