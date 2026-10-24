import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatTime,
  formatUsdc,
  parseUsdc,
  shortId,
} from "./format";

describe("parseUsdc", () => {
  it("preserves values above the safe integer limit and all six decimal places", () => {
    expect(parseUsdc("9007199254740993.123456")).toBe("9007199254740993123456");
    expect(parseUsdc("0.000001")).toBe("1");
    expect(parseUsdc("42.1")).toBe("42100000");
    expect(parseUsdc("00042.100000")).toBe("42100000");
    expect(parseUsdc("0")).toBe("0");
  });

  it.each([
    "",
    " ",
    " 1",
    "1 ",
    "-1",
    "+1",
    "1e6",
    "1E6",
    "1,000",
    ".5",
    "1.",
    "0.0000001",
    "NaN",
    "Infinity",
    "1\n",
  ])("rejects invalid format %j", (input) => {
    expect(parseUsdc(input)).toBeNull();
  });
});

describe("formatUsdc", () => {
  it("formats exact atomic strings without a floating-point round trip", () => {
    expect(formatUsdc("9007199254740993123456")).toBe(
      "9,007,199,254,740,993.123456",
    );
    expect(formatUsdc(9007199254740993123456n)).toBe(
      "9,007,199,254,740,993.123456",
    );
    expect(formatUsdc("1")).toBe("0.000001");
    expect(formatUsdc("1000000")).toBe("1");
    expect(formatUsdc("1234560000")).toBe("1,234.56");
    expect(formatUsdc("0000000")).toBe("0");
  });

  it("truncates requested display precision instead of rounding the underlying amount", () => {
    expect(formatUsdc("1999999", { maxFraction: 2 })).toBe("1.99");
    expect(formatUsdc("1999999", { maxFraction: 0 })).toBe("1");
    expect(formatUsdc("1999999", { maxFraction: 9 })).toBe("1.999999");
    expect(formatUsdc("1000001", { maxFraction: NaN })).toBe("1.000001");
  });

  it.each(["", "-1", "1.1", "1e6", "1,000", " 100", "100\n"])(
    "rejects invalid atomic format %j",
    (input) => {
      expect(formatUsdc(input)).toBe("—");
    },
  );

  it("round trips precise decimal inputs", () => {
    const atomic = parseUsdc("123456789012345678901234567890.123456");
    expect(atomic).not.toBeNull();
    expect(formatUsdc(atomic!)).toBe(
      "123,456,789,012,345,678,901,234,567,890.123456",
    );
  });
});

describe("identifiers and local dates", () => {
  it("keeps both identifier ends and leaves short values intact", () => {
    expect(shortId("0x1234567890abcdef0123456789abcdef")).toBe(
      "0x123456…89abcdef",
    );
    expect(shortId("0x123456789abcdef", 4)).toBe("0x12…cdef");
    expect(shortId("short")).toBe("short");
  });

  it("uses the Shanghai date across a UTC day boundary", () => {
    expect(formatTime("2026-10-23T16:05:00Z")).toBe("00:05");
    expect(formatDate("2026-10-23T16:05:00Z")).toBe("2026-10-24");
    expect(formatTime("2026-10-24T08:30:00+08:00")).toBe("08:30");
  });

  it("gives a safe fallback for invalid timestamps", () => {
    expect(formatTime("invalid")).toBe("—");
    expect(formatDate("")).toBe("—");
  });
});
