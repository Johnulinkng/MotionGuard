const USDC_DECIMALS = 6;
const USDC_SCALE = 1_000_000n;
const INVALID_VALUE = "—";

/** Convert an unsigned decimal USDC amount to its exact atomic-unit string. */
export function parseUsdc(input: string): string | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(input) || input.trim() !== input) return null;

  const [whole, fraction = ""] = input.split(".");
  return (
    BigInt(whole) * USDC_SCALE +
    BigInt(fraction.padEnd(USDC_DECIMALS, "0"))
  ).toString();
}

/** Format atomic units without converting the amount to floating-point numbers. */
export function formatUsdc(
  atomic: string | bigint,
  options: { maxFraction?: number } = {},
): string {
  const input = typeof atomic === "bigint" ? atomic.toString() : atomic;
  if (!/^\d+$/.test(input) || input.trim() !== input) return INVALID_VALUE;

  const amount = BigInt(input);
  const whole = (amount / USDC_SCALE)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const requestedFraction = options.maxFraction ?? USDC_DECIMALS;
  const maxFraction = Number.isFinite(requestedFraction)
    ? Math.min(USDC_DECIMALS, Math.max(0, Math.trunc(requestedFraction)))
    : USDC_DECIMALS;
  const fraction = (amount % USDC_SCALE)
    .toString()
    .padStart(USDC_DECIMALS, "0")
    .slice(0, maxFraction)
    .replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole;
}

/** Preserve both ends of identifiers, including the checksum or final sequence. */
export function shortId(value: string, length = 8): string {
  const edgeLength = Math.max(1, Math.trunc(length) || 8);
  return value.length > edgeLength * 2 + 1
    ? `${value.slice(0, edgeLength)}…${value.slice(-edgeLength)}`
    : value;
}

const shanghaiTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const shanghaiDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? INVALID_VALUE
    : shanghaiTime.format(date);
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return INVALID_VALUE;
  const parts = shanghaiDate.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
