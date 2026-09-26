/** Small formatting helpers shared by the bot and the scanner. */

/**
 * The formatter cache (2026-09-26).
 *
 * WHY: `new Intl.NumberFormat` is not cheap, and this file used to build a new
 * one PER CALL. Measured off-platform over the real functions and the real
 * re-eval pool (scripts/cpu-profile.js, `eval:` legs): ~25 µs per construction
 * plus format, and ~15 ms for the FIRST use in a process (ICU/data init) — the
 * number a COLD isolate pays, and this Worker's isolates are recycled often.
 *
 * WHERE IT LANDS: the scan's per-coin evaluation builds a reject message for
 * every coin a chat refuses — not only for the ones the capped log keeps — and
 * each message calls this function once or twice ("流动性 $x < $y", "動能不足…").
 * Measured on the 2026-09-26 pool: `Scanner.matchCoins` over 113 PAIRED coins
 * (the gate path, ~94 of them refused) cost **4.6-8.5 ms of CPU** with the
 * per-call construction, and **0.26-0.36 ms** with this cache — the whole
 * doubled-coin leg fell from 15.6 ms to 2.1 ms. `fmtUsd` itself reads ~25 µs
 * per call before and ~1 µs after (both measured, see the `eval:` legs in
 * scripts/cpu-profile.js), so the allocation really was the per-coin cost.
 *
 * WHY A CACHE IS SAFE HERE: `Intl.NumberFormat` is stateless between calls (it
 * is a formatter, not an accumulator), the option sets below are a CLOSED set
 * (one compact shape plus three decimal widths, so the cache is bounded at
 * four entries for the process's life), and the numbers are formatted the same
 * way — the readings in scripts/cpu-profile.js compare before/after, and
 * scripts/test-usd-formatter.js pins the OUTPUT for every branch, not just the
 * call count.
 */
const numberFormatCache = new Map<string, Intl.NumberFormat>();

function cachedNumberFormat(key: string, make: () => Intl.NumberFormat): Intl.NumberFormat {
  let fmt = numberFormatCache.get(key);
  if (!fmt) {
    fmt = make();
    numberFormatCache.set(key, fmt);
  }
  return fmt;
}

export function fmtUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000) {
    return cachedNumberFormat(
      "compact",
      () =>
        new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          notation: "compact",
          maximumFractionDigits: 2,
        }),
    ).format(value);
  }
  const decimals = value >= 1 ? 2 : value >= 0.0001 ? 6 : 8;
  return cachedNumberFormat(
    `fixed${decimals}`,
    () =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }),
  ).format(value);
}

export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Parse a user-supplied number, tolerating thousands separators. */
export function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
