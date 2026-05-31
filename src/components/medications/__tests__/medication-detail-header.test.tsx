/**
 * v1.5.5 D-3 §9.1 + §10 invariant 5 — status pill renders the label
 * always (never colour-only) and the dot rides Dracula tokens.
 *
 * Critical because an earlier draft proposed bare Tailwind palette
 * (`bg-emerald-500` / `bg-amber-500`) which:
 *   - bypasses the theme so it would not flip with dark/light;
 *   - relied on colour alone to convey state (WCAG 1.4.1 violation);
 *   - drifted out of sync with `--success` / `--warning` Dracula
 *     tokens declared in `src/app/globals.css`.
 *
 * These tests pin the contract:
 *   - active medication → label "Aktiv" + Dracula `--success` token
 *   - paused medication → label "Pausiert" + `--warning` token
 *   - ended medication  → label "Beendet" + muted-foreground
 *   - dot always carries `aria-hidden="true"`
 *   - DOM order: H1 (name) before the edit button (C-E4-3)
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({
    t: (key: string) => key,
  }),
}));

import { MedicationDetailHeader } from "@/components/medications/medication-detail-header";

function render(props: {
  name?: string;
  dose?: string;
  active?: boolean;
  endsOn?: string | null;
}) {
  return renderToStaticMarkup(
    <MedicationDetailHeader
      name={props.name ?? "Test Drug"}
      dose={props.dose ?? "5 mg"}
      active={props.active ?? true}
      endsOn={props.endsOn}
      onEditPlan={() => {}}
      onOpenHistory={() => {}}
      onOpenAdvanced={() => {}}
    />,
  );
}

describe("MedicationDetailHeader (D-3 §9.1)", () => {
  it("renders the status label and the --success dot for an active medication", () => {
    const html = render({ active: true });
    expect(html).toContain("medications.detail.status.active");
    expect(html).toContain("[hsl(var(--success))]");
    expect(html).toContain('aria-hidden="true"');
  });

  it("renders the paused label + --warning dot for an inactive medication", () => {
    const html = render({ active: false });
    expect(html).toContain("medications.detail.status.paused");
    expect(html).toContain("[hsl(var(--warning))]");
  });

  it("renders the ended label + muted dot when endsOn is past", () => {
    const html = render({
      active: false,
      endsOn: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(html).toContain("medications.detail.status.ended");
    expect(html).toContain("bg-muted-foreground");
  });

  it("DOM order is heading before edit button (C-E4-3)", () => {
    const html = render({ active: true });
    const headingIndex = html.indexOf("<h1");
    const buttonIndex = html.indexOf(
      'data-slot="medication-detail-edit-button"',
    );
    expect(headingIndex).toBeGreaterThan(-1);
    expect(buttonIndex).toBeGreaterThan(-1);
    expect(headingIndex).toBeLessThan(buttonIndex);
  });

  it("renders the edit, history and advanced buttons (v1.7.0)", () => {
    const html = render({ active: true });
    expect(html).toContain("common.edit");
    expect(html).toContain('data-slot="medication-detail-edit-button"');
    expect(html).toContain('data-slot="medication-detail-history-button"');
    expect(html).toContain('data-slot="medication-detail-advanced-button"');
    expect(html).toContain(
      'aria-label="medications.detail.header.historyLabel"',
    );
    expect(html).toContain(
      'aria-label="medications.detail.header.advancedLabel"',
    );
  });

  it("orders the buttons edit → history → advanced", () => {
    const html = render({ active: true });
    const edit = html.indexOf('data-slot="medication-detail-edit-button"');
    const history = html.indexOf(
      'data-slot="medication-detail-history-button"',
    );
    const advanced = html.indexOf(
      'data-slot="medication-detail-advanced-button"',
    );
    expect(edit).toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(edit);
    expect(advanced).toBeGreaterThan(history);
  });

  it("status pill text always renders (no colour-only state)", () => {
    // Regardless of theme support the label MUST be in the DOM so a
    // screen reader announces "Aktiv" even when the dot's hue is
    // imperceptible to the user.
    const activeHtml = render({ active: true });
    const pausedHtml = render({ active: false });
    expect(activeHtml).toMatch(
      /data-slot="medication-detail-status-row"[\s\S]*?medications\.detail\.status\.active/,
    );
    expect(pausedHtml).toMatch(
      /data-slot="medication-detail-status-row"[\s\S]*?medications\.detail\.status\.paused/,
    );
  });
});
