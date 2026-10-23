import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cdp } from "vitest/browser";

import { installTextMeasurementHost } from "../text-measurement-host";

/**
 * Recharts sizes every axis label by writing it into the measurement span
 * with the label's font size and reading the box back in the same task. The
 * reduced-motion backstop in `globals.css` gives every element a 0.01 ms
 * transition, and the default transition property is `all`, so a font size
 * written into the span started a transition and the read returned the size
 * it had before. Under reduced motion a label was measured at whatever size
 * the previous one had, or at the inherited 16 px: the last date label moved
 * in from the chart's edge, and value labels that fit were dropped as
 * colliding, differently from one visit to the next. The host takes its
 * subtree out of transitions; this pins that the read sees the size just
 * written, under reduced motion and without it.
 */

const LABEL = "10/22/2026";

function referenceWidth(fontSize: string): number {
  const span = document.createElement("span");
  span.style.cssText = `position:absolute;top:-20000px;white-space:pre;font-size:${fontSize}`;
  span.textContent = LABEL;
  document.body.appendChild(span);
  const width = span.getBoundingClientRect().width;
  span.remove();
  return width;
}

/** What Recharts does for every label: style the shared span, then read it. */
function measureLikeRecharts(span: HTMLElement, fontSize: string): number {
  Object.assign(span.style, {
    position: "absolute",
    top: "-20000px",
    whiteSpace: "pre",
    fontSize,
  });
  span.textContent = LABEL;
  return span.getBoundingClientRect().width;
}

async function emulateReducedMotion(value: "reduce" | "no-preference") {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value }],
  });
}

describe("text measurement host", () => {
  beforeEach(() => {
    document
      .querySelector('[data-slot="chart-text-measurement-host"]')
      ?.remove();
  });

  afterEach(async () => {
    await emulateReducedMotion("no-preference");
  });

  for (const motion of ["reduce", "no-preference"] as const) {
    it(`reads the size just written (${motion})`, async () => {
      await emulateReducedMotion(motion);
      expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(
        motion === "reduce",
      );
      const span = installTextMeasurementHost();
      expect(span).not.toBeNull();

      // The axis's first pass measures before it knows the tick font size,
      // then measures again at it: both reads must reflect their own size.
      const inherited = measureLikeRecharts(span!, "");
      const small = measureLikeRecharts(span!, "11px");
      const large = measureLikeRecharts(span!, "20px");
      const smallAgain = measureLikeRecharts(span!, "11px");

      const reference = referenceWidth("11px");
      expect(reference).toBeGreaterThan(30);
      expect(small).toBeCloseTo(reference, 1);
      expect(smallAgain).toBeCloseTo(reference, 1);
      expect(large).toBeGreaterThan(small * 1.5);
      expect(inherited).toBeGreaterThan(small);
    });
  }
});
