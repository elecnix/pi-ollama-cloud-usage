import { describe, expect, it } from "vitest";
import { parseUsage, UsageError } from "../usage.ts";

const SAMPLE = {
  activity: { cost: "0.00000", period: { type: "last_4_weeks" }, models: [] },
  limits: {
    session: { usage: 0.647, models: [{ name: "glm-5.2", request_count: 691 }] },
    weekly: { usage: 0.94, models: [{ name: "glm-5.2", request_count: 6059 }] },
  },
};

describe("parseUsage", () => {
  it("extracts session/weekly percentages from 0-1 fractions", () => {
    const u = parseUsage(SAMPLE);
    expect(u.sessionPct).toBeCloseTo(64.7, 1);
    expect(u.weeklyPct).toBeCloseTo(94, 1);
    expect(u.extraPct).toBeNull();
    expect(u.sessionModels).toHaveLength(1);
    expect(u.weeklyModels[0].name).toBe("glm-5.2");
    expect(u.weeklyModels[0].request_count).toBe(6059);
  });

  it("tolerates already-percent values (0-100)", () => {
    const u = parseUsage({ limits: { session: { usage: 42 }, weekly: { usage: 77 } } });
    expect(u.sessionPct).toBe(42);
    expect(u.weeklyPct).toBe(77);
  });

  it("parses extra usage defensively from limits.extra.usage", () => {
    const u = parseUsage({ limits: { session: { usage: 0.1 }, weekly: { usage: 0.2 }, extra: { usage: 0.83 } } });
    expect(u.extraPct).toBeCloseTo(83, 1);
  });

  it("parses extra usage from a top-level balance fraction", () => {
    const u = parseUsage({ limits: { session: { usage: 0 }, weekly: { usage: 0 } }, balance: 0.95 });
    expect(u.extraPct).toBeCloseTo(95, 1);
  });

  it("defaults missing usage to 0 and extra to null", () => {
    const u = parseUsage({ limits: {} });
    expect(u.sessionPct).toBe(0);
    expect(u.weeklyPct).toBe(0);
    expect(u.extraPct).toBeNull();
    expect(u.sessionModels).toEqual([]);
  });

  it("throws on non-object input", () => {
    expect(() => parseUsage("nope")).toThrow(UsageError);
    expect(() => parseUsage(null)).toThrow(UsageError);
    expect(() => parseUsage(undefined)).toThrow(UsageError);
  });
});