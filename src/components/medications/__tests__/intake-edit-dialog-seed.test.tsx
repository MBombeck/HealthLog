/**
 * v1.5.6 G-1 §9 Q1 — IntakeEditDialog seeds from the row's real
 * values.
 *
 * Before this pass the preview opened the dialog with a stub
 * `{ id, takenAt: null, skipped: false }`, so "Bearbeiten" always
 * showed an empty form. The fix threads the whole `IntakeEvent` up
 * through `onEditIntake(event)`; this test pins that the dialog's
 * datetime-local input + skipped switch seed from the event passed in.
 *
 * `<Dialog>` wraps a Radix portal that `renderToStaticMarkup` does not
 * materialise, so we mock the dialog primitives to passthroughs.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({}),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="mock-dialog">{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { IntakeEditDialog } from "@/components/medications/intake-edit-dialog";

describe("IntakeEditDialog seed (G-1 §9 Q1)", () => {
  it("seeds the datetime-local input from the event's real takenAt", () => {
    // 2026-03-04T09:30 in local time — the dialog formats to
    // `YYYY-MM-DDTHH:mm` in the user's timezone.
    const taken = new Date(2026, 2, 4, 9, 30).toISOString();
    const html = renderToStaticMarkup(
      <IntakeEditDialog
        medicationId="med-1"
        event={{ id: "evt-1", takenAt: taken, skipped: false }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('value="2026-03-04T09:30"');
  });

  it("seeds the skipped switch from a skipped event (no stub default)", () => {
    const html = renderToStaticMarkup(
      <IntakeEditDialog
        medicationId="med-1"
        event={{ id: "evt-2", takenAt: null, skipped: true }}
        onClose={() => {}}
      />,
    );
    // Radix Switch reflects checked state via data-state.
    expect(html).toContain('data-state="checked"');
  });

  it("renders nothing when no event is selected", () => {
    const html = renderToStaticMarkup(
      <IntakeEditDialog medicationId="med-1" event={null} onClose={() => {}} />,
    );
    expect(html).toBe("");
  });
});
