/**
 * Quota bar rendering — pure functions, unit-tested.
 *
 * The Ollama Cloud `/api/usage` endpoint exposes `limits.session.usage` and
 * `limits.weekly.usage` as 0–1 fractions but does NOT expose reset timestamps,
 * so we cannot compute a pace (usage% vs elapsed%). Color is therefore by
 * absolute threshold, not by pace.
 */

export type BarColor = "success" | "accent" | "warning" | "error";

/** Color by absolute usage threshold. */
export function barColor(pct: number): BarColor {
  if (pct >= 90) return "error";
  if (pct >= 80) return "warning";
  if (pct >= 50) return "accent";
  return "success";
}

/**
 * Render `label ▕███░░░░░░▏ pct%` with `cells` bar cells.
 * Filled cells use floor(pct / (100 / cells)) so each cell = one increment.
 */
export function renderBar(label: string, pct: number, cells = 10): string {
  const p = Math.max(0, Math.min(100, pct));
  const perCell = 100 / cells;
  const filled = Math.min(cells, Math.floor(p / perCell));
  const empty = cells - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `${label} ▕${bar}▏ ${Math.round(p)}%`;
}
