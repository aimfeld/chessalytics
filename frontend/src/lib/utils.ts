import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Parse a "YYYY-MM-DD" string (a full ISO 8601 timestamp also works — its
 * time part is ignored) into a Date (local time). */
function parseDate(d: string): Date {
  // Bug fix (190.1 UAT): callers pass full ISO timestamps too (e.g.
  // games.played_at "2026-07-20T12:00:00Z"); splitting the raw string on '-'
  // made the day component "20T12:00:00Z" -> NaN -> "Invalid Date".
  const datePart = d.split('T')[0] ?? d;
  const [year, month, day] = datePart.split('-');
  return new Date(Number(year), Number(month) - 1, Number(day));
}

/** Days between first and last date in a sorted YYYY-MM-DD array. */
function dateRangeDays(dates: string[]): number {
  if (dates.length < 2) return 0;
  // safe: length check above guarantees both indices are in bounds
  const first = parseDate(dates[0]!);
  const last = parseDate(dates[dates.length - 1]!);
  return Math.round((last.getTime() - first.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Returns a tick formatter that adapts to the date range:
 * - > 18 months: "Jan '24" (month + abbreviated year)
 * - > 2 months:  "Jan 5"   (month + day)
 * - <= 2 months: "Jan 5"   (month + day)
 */
export function createDateTickFormatter(sortedDates: string[]): (d: string) => string {
  const span = dateRangeDays(sortedDates);
  const EIGHTEEN_MONTHS = 18 * 30;

  if (span > EIGHTEEN_MONTHS) {
    return (d: string) => {
      const date = parseDate(d);
      const month = date.toLocaleDateString('en-US', { month: 'short' });
      const year = String(date.getFullYear()).slice(2);
      return `${month} '${year}`;
    };
  }

  return (d: string) => {
    return parseDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
}

/** Format a YYYY-MM-DD date with full year for tooltips. */
export function formatDateWithYear(d: string): string {
  return parseDate(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Compute a nice y-axis domain and evenly-spaced ticks for win-rate data (0–1).
 * Uses 10% steps when range ≤ 40%, otherwise 20% steps.
 */
export function niceWinRateAxis(values: number[]): { domain: [number, number]; ticks: number[] } {
  if (values.length === 0) return { domain: [0, 1], ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] };

  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const step = (dataMax - dataMin) <= 0.4 ? 0.1 : 0.2;

  const lo = Math.max(0, Math.floor(dataMin / step) * step);
  const hi = Math.min(1, Math.ceil(dataMax / step) * step);

  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) {
    ticks.push(Math.round(v * 100) / 100);
  }
  return { domain: [lo, hi], ticks };
}

/**
 * Compute a nice y-axis domain and evenly-spaced ticks for Elo rating data.
 * Uses step candidates [50, 100, 200, 500]; picks the largest step where
 * range / step >= 4 (aim for 4-8 ticks). Lifted from RatingChart.tsx:54-106.
 *
 * Fallbacks:
 * - empty values: { domain: ['auto', 'auto'], ticks: undefined } (Recharts auto-scale).
 * - all values equal: expand min -= 50, max += 50 so ticks are meaningful.
 *
 * 57-UI-SPEC.md §Axes prescribes this signature and step set.
 */
export function niceEloAxis(
  values: number[],
): { domain: [number, number] | ['auto', 'auto']; ticks: number[] | undefined } {
  if (values.length === 0) {
    return { domain: ['auto', 'auto'], ticks: undefined };
  }

  let min = Math.min(...values);
  let max = Math.max(...values);

  // All values equal -> pad so ticks render.
  if (min === max) {
    min -= 50;
    max += 50;
  }

  const range = max - min;

  // Pick the largest step where range/step >= 4.
  const STEP_CANDIDATES = [50, 100, 200, 500];
  // Start at 50 (smallest) to avoid noUncheckedIndexedAccess widening.
  let step = 50;
  for (const candidate of STEP_CANDIDATES) {
    if (range / candidate >= 4) {
      step = candidate;
    }
  }

  const domainMin = Math.floor(min / step) * step;
  const domainMax = Math.ceil(max / step) * step;

  const ticks: number[] = [];
  for (let t = domainMin; t <= domainMax; t += step) {
    ticks.push(t);
  }

  return { domain: [domainMin, domainMax], ticks };
}
