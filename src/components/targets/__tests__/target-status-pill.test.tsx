import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  TargetStatusPill,
  statusGroupForCategory,
} from "../target-status-pill";

/**
 * v1.8.5 — `<TargetStatusPill>` was extracted from `target-card.tsx`
 * so the Targets card and the Insights reference panel render the
 * identical pill from the same server-emitted classification category.
 * These tests pin the category → semantic-group mapping (which drives
 * the pill colour) and the rendered label + range/source popover.
 */

function render(props: Parameters<typeof TargetStatusPill>[0]) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <TargetStatusPill {...props} />
    </I18nProvider>,
  );
}

describe("statusGroupForCategory", () => {
  it("paints in-band categories green", () => {
    expect(statusGroupForCategory("Normal")).toBe("in");
    expect(statusGroupForCategory("Optimal")).toBe("in");
    expect(statusGroupForCategory("On target")).toBe("in");
  });

  it("paints far-out categories red", () => {
    expect(statusGroupForCategory("Hypertension Grade 3")).toBe("out");
    expect(statusGroupForCategory("Significantly elevated")).toBe("out");
  });

  it("falls back to amber for the resting-pulse bands (no clinical-verdict red)", () => {
    // v1.29.6 — "Below typical range" / "Above typical range" replaced the
    // diagnosis-shaped "Bradycardia" / "Tachycardia" categories and no
    // longer paint the pill destructive-red.
    expect(statusGroupForCategory("Below typical range")).toBe("near");
    expect(statusGroupForCategory("Above typical range")).toBe("near");
  });

  it("falls back to amber for caution + unmapped categories", () => {
    expect(statusGroupForCategory("Slightly elevated")).toBe("near");
    expect(statusGroupForCategory("Overweight")).toBe("near");
    expect(statusGroupForCategory("Totally Unknown Category")).toBe("near");
  });
});

describe("<TargetStatusPill>", () => {
  it("renders the translated label + the in/out status attribute", () => {
    const html = render({
      classification: { category: "Optimal", color: "#50fa7b" },
      range: { min: 120, max: 129 },
      unit: "mmHg",
      source: "ESH 2023",
    });
    expect(html).toContain('data-slot="target-status-pill"');
    expect(html).toContain('data-status="in"');
    expect(html).toContain("Optimal");
    // The pill sits in a button that opens the range and source on a tap;
    // the popover is closed, so its content is not in static markup.
    expect(html).toMatch(/<button type="button"[^>]*aria-haspopup="dialog"/);
    expect(html).toContain('data-state="closed"');
  });

  it("renders the raw category when no translation key matches", () => {
    const html = render({
      classification: { category: "Totally Unknown Category", color: "#fff" },
      range: null,
      unit: "kg",
      source: "Custom",
    });
    expect(html).toContain("Totally Unknown Category");
    expect(html).toContain('data-status="near"');
  });
});
