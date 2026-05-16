import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetChartTooltipObserverForTests,
  getChartTooltipActive,
  getChartTooltipActiveServer,
  subscribeChartTooltipActive,
} from "../chart-tooltip-observer";

/**
 * v1.4.33 (F15) — chart-tooltip observer contract tests.
 *
 * The full DOM-side behaviour (MutationObserver watching `[class*=
 * "recharts-tooltip-wrapper"]` visibility flips) lives behind a guard
 * that no-ops when `document` is undefined — which is the case in the
 * default vitest node environment. These tests pin the SSR-safe path
 * and the subscribe/snapshot contract that `useSyncExternalStore`
 * leans on.
 *
 * The integration with a real Recharts tooltip is exercised via the
 * Playwright suite (mobile insight chart hover → FAB fades).
 */

describe("chart-tooltip-observer", () => {
  beforeEach(() => {
    __resetChartTooltipObserverForTests();
  });

  afterEach(() => {
    __resetChartTooltipObserverForTests();
  });

  it("getChartTooltipActiveServer always returns false", () => {
    // The SSR snapshot must never claim a tooltip is active on the
    // server — there's no DOM to inspect, and a stale `true` would
    // render the FAB invisible on the initial pass.
    expect(getChartTooltipActiveServer()).toBe(false);
  });

  it("getChartTooltipActive returns false when no wrappers exist", () => {
    expect(getChartTooltipActive()).toBe(false);
  });

  it("subscribeChartTooltipActive returns an unsubscribe function", () => {
    const unsubscribe = subscribeChartTooltipActive(() => undefined);
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });

  it("no-ops cleanly on a server-side render (no document available)", () => {
    // Document is undefined in the vitest node environment — the
    // module's `start()` early-returns. Subscribing should still
    // succeed; the listener simply never fires.
    let calls = 0;
    const unsubscribe = subscribeChartTooltipActive(() => {
      calls += 1;
    });
    expect(getChartTooltipActive()).toBe(false);
    expect(calls).toBe(0);
    unsubscribe();
  });

  it("supports multiple subscribers without throwing", () => {
    const a = subscribeChartTooltipActive(() => undefined);
    const b = subscribeChartTooltipActive(() => undefined);
    expect(getChartTooltipActive()).toBe(false);
    a();
    b();
  });
});
