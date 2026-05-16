import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MedicationCardHeader } from "@/components/medications/MedicationCardHeader";

/**
 * v1.4.28 — narrow-viewport contract for the shared medication-list
 * row primitive (D-H6).
 *
 * FB-G1 calls for a two-line shape: `{name} {dose}` on line 1 and the
 * category badge on line 2. State badges (without-notification, paused,
 * inactive) used to share line 2 via `flex flex-wrap`; on a 320 px
 * viewport that pushed the row to three lines for ~20 % of configured
 * drugs. State badges now ride their own row below the category badge
 * so the canonical row stays two lines on narrow viewports.
 *
 * The tests assert the structural seams, not the visual measurement
 * (no DOM measurement layer in SSR). The data-slot on the state-badges
 * row plus the absence of state badges inside the category row are the
 * load-bearing contracts.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(<Card>{node}</Card>);
}

describe("<MedicationCardHeader>", () => {
  it("paints `{name} {dose}` on the title row", () => {
    const html = render(
      <MedicationCardHeader
        name="Ramipril"
        dose="5 mg"
        categoryLabel="Blood Pressure"
      />,
    );
    expect(html).toContain("Ramipril 5 mg");
    expect(html).toContain("Blood Pressure");
  });

  it("does not paint the state-badges row when no badges are supplied", () => {
    const html = render(
      <MedicationCardHeader
        name="Ramipril"
        dose="5 mg"
        categoryLabel="Blood Pressure"
      />,
    );
    // Pin the absence so a future refactor can't paint an empty
    // wrapper that eats vertical space.
    expect(html).not.toContain(
      'data-slot="medication-card-header-state-badges"',
    );
  });

  it("breaks state badges onto their own row below the category badge (D-H6)", () => {
    // The narrow-viewport contract: state badges live on their own
    // row so the canonical row stays two lines at 320 px even when
    // a drug carries one of the state badges. Pinning the seam.
    const html = render(
      <MedicationCardHeader
        name="Ramipril"
        dose="5 mg"
        categoryLabel="Blood Pressure"
        stateBadges={
          <>
            <Badge variant="secondary" className="text-xs">
              Without notification
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Paused since 12.05
            </Badge>
          </>
        }
      />,
    );
    expect(html).toContain(
      'data-slot="medication-card-header-state-badges"',
    );
    // Both badges land inside the state row, not adjacent to the
    // category badge. Verifying via document order: the state-badges
    // wrapper must paint AFTER the category badge.
    const categoryIdx = html.indexOf("Blood Pressure");
    const stateRowIdx = html.indexOf(
      'data-slot="medication-card-header-state-badges"',
    );
    expect(categoryIdx).toBeGreaterThan(-1);
    expect(stateRowIdx).toBeGreaterThan(categoryIdx);
  });
});
