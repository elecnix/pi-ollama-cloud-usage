import { describe, expect, it } from "vitest";
import { computeAlerts, initialThresholdState, seedState } from "../alerts.ts";

describe("computeAlerts — session/weekly 10% increments", () => {
  it("emits one alert per newly-crossed 10% increment", () => {
    const r = computeAlerts(initialThresholdState(), { session: 25, weekly: 0, extra: null });
    const thresholds = r.alerts.filter((a) => a.metric === "session").map((a) => a.threshold);
    expect(thresholds).toEqual([10, 20]);
    expect(r.state.session).toBe(20);
  });

  it("does not re-emit already-crossed thresholds", () => {
    const r1 = computeAlerts(initialThresholdState(), { session: 25, weekly: 0, extra: null });
    const r2 = computeAlerts(r1.state, { session: 28, weekly: 0, extra: null });
    expect(r2.alerts).toHaveLength(0);
    const r3 = computeAlerts(r2.state, { session: 32, weekly: 0, extra: null });
    expect(r3.alerts.map((a) => a.threshold)).toEqual([30]);
  });

  it("re-arms after a window reset (pct drops below already-notified)", () => {
    let r = computeAlerts(initialThresholdState(), { session: 95, weekly: 0, extra: null });
    expect(r.state.session).toBe(90);
    r = computeAlerts(r.state, { session: 12, weekly: 0, extra: null });
    expect(r.state.session).toBe(10);
    expect(r.alerts.map((a) => a.threshold)).toEqual([10]);
    r = computeAlerts(r.state, { session: 22, weekly: 0, extra: null });
    expect(r.alerts.map((a) => a.threshold)).toEqual([20]);
  });

  it("escalates level for session/weekly", () => {
    const r = computeAlerts(initialThresholdState(), { session: 92, weekly: 0, extra: null });
    const last = r.alerts.at(-1)!;
    expect(last.level).toBe("error");
    const r2 = computeAlerts(initialThresholdState(), { session: 0, weekly: 84, extra: null });
    expect(r2.alerts.find((a) => a.metric === "weekly")?.level).toBe("warning");
  });
});

describe("computeAlerts — extra usage 80/95 only", () => {
  it("stays silent below 80%", () => {
    const r = computeAlerts(initialThresholdState(), { session: 0, weekly: 0, extra: 50 });
    expect(r.alerts).toHaveLength(0);
  });

  it("fires warning at 80%", () => {
    const r = computeAlerts(initialThresholdState(), { session: 0, weekly: 0, extra: 81 });
    expect(r.alerts.map((a) => a.threshold)).toEqual([80]);
    expect(r.alerts[0].level).toBe("warning");
  });

  it("fires error at 95% and not before", () => {
    let r = computeAlerts(initialThresholdState(), { session: 0, weekly: 0, extra: 81 });
    r = computeAlerts(r.state, { session: 0, weekly: 0, extra: 90 });
    expect(r.alerts).toHaveLength(0);
    r = computeAlerts(r.state, { session: 0, weekly: 0, extra: 96 });
    expect(r.alerts.map((a) => a.threshold)).toEqual([95]);
    expect(r.alerts[0].level).toBe("error");
  });

  it("ignores extra when null", () => {
    const r = computeAlerts(initialThresholdState(), { session: 0, weekly: 0, extra: null });
    expect(r.alerts).toHaveLength(0);
    expect(r.state.extra).toBe(0);
  });
});

describe("seedState", () => {
  it("seeds to the current floor without emitting (verified by subsequent compute)", () => {
    const s = seedState({ session: 64.7, weekly: 94, extra: 83 });
    expect(s.session).toBe(60);
    expect(s.weekly).toBe(90);
    expect(s.extra).toBe(80);
    // A tiny bump after seeding must NOT re-fire the seeded thresholds.
    // A small bump after seeding must NOT re-fire the seeded thresholds.
    const r = computeAlerts(s, { session: 66, weekly: 95, extra: 84 });
    expect(r.alerts.filter((a) => a.metric === "session")).toHaveLength(0);
    expect(r.alerts.filter((a) => a.metric === "weekly")).toHaveLength(0);
    expect(r.alerts.filter((a) => a.metric === "extra")).toHaveLength(0);
    // Reaching the next unseeded threshold DOES fire.
    const r2 = computeAlerts(s, { session: 70, weekly: 100, extra: 95 });
    expect(r2.alerts.find((a) => a.metric === "session")?.threshold).toBe(70);
    expect(r2.alerts.find((a) => a.metric === "weekly")?.threshold).toBe(100);
    expect(r2.alerts.find((a) => a.metric === "extra")?.threshold).toBe(95);
  });
});