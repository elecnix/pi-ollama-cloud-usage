import { describe, expect, it } from "vitest";
import { barColor, renderBar } from "../bar.ts";

/** Slice the cells between ▕ and ▏. */
function cells(s: string): string {
  return s.slice(s.indexOf("▕") + 1, s.indexOf("▏"));
}

describe("renderBar", () => {
  it("renders 10 cells with floor(pct/10) filled", () => {
    expect(cells(renderBar("5h", 0)).length).toBe(10);
    expect((cells(renderBar("5h", 0)).match(/█/g) ?? []).length).toBe(0);
    expect((cells(renderBar("5h", 65)).match(/█/g) ?? []).length).toBe(6);
    expect((cells(renderBar("5h", 94)).match(/█/g) ?? []).length).toBe(9);
    expect((cells(renderBar("5h", 100)).match(/█/g) ?? []).length).toBe(10);
    expect(renderBar("5h", 65)).toBe("5h ▕██████░░░░▏ 65%");
    expect(renderBar("5h", 100)).toBe("5h ▕██████████▏ 100%");
  });

  it("clamps out-of-range percentages", () => {
    expect(renderBar("7d", -5)).toBe(renderBar("7d", 0));
    expect(renderBar("7d", 150)).toBe("7d ▕██████████▏ 100%");
  });

  it("supports a custom cell count", () => {
    const s = renderBar("$", 50, 4);
    expect(cells(s).length).toBe(4);
    expect((cells(s).match(/█/g) ?? []).length).toBe(2);
    expect(s).toBe("$ ▕██░░▏ 50%");
  });
});

describe("barColor", () => {
  it("colors by absolute threshold", () => {
    expect(barColor(0)).toBe("success");
    expect(barColor(49)).toBe("success");
    expect(barColor(50)).toBe("accent");
    expect(barColor(79)).toBe("accent");
    expect(barColor(80)).toBe("warning");
    expect(barColor(89)).toBe("warning");
    expect(barColor(90)).toBe("error");
    expect(barColor(100)).toBe("error");
  });
});