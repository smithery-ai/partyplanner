import { describe, expect, it } from "vitest";
import { cronMatches, parseCron } from "../src/cron";

const at = (iso: string) => new Date(iso);

describe("parseCron", () => {
  it("parses all-wildcards", () => {
    const p = parseCron("* * * * *");
    expect(p).toEqual({
      minute: "any",
      hour: "any",
      dayOfMonth: "any",
      month: "any",
      dayOfWeek: "any",
    });
  });

  it("parses step expressions", () => {
    const p = parseCron("*/15 * * * *");
    expect(p.minute).toEqual([0, 15, 30, 45]);
  });

  it("parses ranges and lists", () => {
    const p = parseCron("0 9-11 * * 1,3,5");
    expect(p.hour).toEqual([9, 10, 11]);
    expect(p.dayOfWeek).toEqual([1, 3, 5]);
  });

  it("parses ranges combined with steps", () => {
    const p = parseCron("0-30/10 * * * *");
    expect(p.minute).toEqual([0, 10, 20, 30]);
  });

  it("rejects expressions with the wrong field count", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("* * * * * *")).toThrow(/5 fields/);
  });

  it("rejects out-of-range fields", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* 24 * * *")).toThrow(/out of range/);
  });

  it("rejects invalid step values", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(/invalid step/);
  });
});

describe("cronMatches", () => {
  it("matches on minute boundaries with */15", () => {
    const p = parseCron("*/15 * * * *");
    expect(cronMatches(p, at("2026-04-27T15:00:00Z"))).toBe(true);
    expect(cronMatches(p, at("2026-04-27T15:15:00Z"))).toBe(true);
    expect(cronMatches(p, at("2026-04-27T15:14:00Z"))).toBe(false);
  });

  it("matches a specific hour-of-day", () => {
    const p = parseCron("0 3 * * *");
    expect(cronMatches(p, at("2026-04-27T03:00:00Z"))).toBe(true);
    expect(cronMatches(p, at("2026-04-27T03:01:00Z"))).toBe(false);
    expect(cronMatches(p, at("2026-04-27T04:00:00Z"))).toBe(false);
  });

  it("treats day-of-week 0 and 7 as Sunday", () => {
    const sunday = at("2026-04-26T12:00:00Z"); // Sunday
    const monday = at("2026-04-27T12:00:00Z");
    expect(cronMatches(parseCron("0 12 * * 0"), sunday)).toBe(true);
    expect(cronMatches(parseCron("0 12 * * 7"), sunday)).toBe(true);
    expect(cronMatches(parseCron("0 12 * * 0"), monday)).toBe(false);
  });

  it("evaluates in UTC regardless of host timezone", () => {
    const p = parseCron("30 14 * * *");
    expect(cronMatches(p, at("2026-04-27T14:30:00Z"))).toBe(true);
    expect(cronMatches(p, at("2026-04-27T07:30:00-07:00"))).toBe(true);
  });

  it("requires every field to match", () => {
    const p = parseCron("0 9 1 1 *"); // Jan 1, 09:00 UTC
    expect(cronMatches(p, at("2026-01-01T09:00:00Z"))).toBe(true);
    expect(cronMatches(p, at("2026-01-02T09:00:00Z"))).toBe(false);
    expect(cronMatches(p, at("2026-02-01T09:00:00Z"))).toBe(false);
  });
});
