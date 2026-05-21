/**
 * v1.4.43 QoL (M3 + L5) — `<AdvancedSection>` danger-zone shaping.
 *
 *   M3: a separate "Delete account entirely" destructive card
 *       (`AccountDeleteCard`) sits beside the existing `DataResetCard`
 *       so a user reading the GDPR Article 17 surface has the full
 *       erasure CTA right next to the half-erasure one.
 *
 *   L5: the data-reset card no longer paints a red `AlertTriangle`
 *       icon and the title sits in the neutral foreground colour
 *       (mirrors GitHub's danger-zone shaping). The CTA button stays
 *       red; the protective confirmation dialog stays unchanged.
 *
 * SSR-only — we render the component statically and inspect the
 * markup. The mutation handlers don't fire in SSR, so this test only
 * pins the visible structure + copy.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// `<AdvancedSection>` mounts the Research Mode card which calls
// `useQuery` and `useQueryClient` under TanStack Query. The other
// shape tests use the same stub.
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/medications/ResearchModeAcknowledgmentDialog", () => ({
  ResearchModeAcknowledgmentDialog: () => (
    <div data-slot="mock-ack-dialog" />
  ),
}));

import { AdvancedSection } from "../advanced-section";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <AdvancedSection />
    </I18nProvider>,
  );
}

describe("<AdvancedSection> danger-zone shaping (v1.4.43 M3 + L5)", () => {
  it("mounts both the data-reset card and the account-delete card", () => {
    const html = render();
    expect(html).toContain('data-slot="settings-data-reset-card"');
    expect(html).toContain('data-slot="settings-account-delete-card"');
  });

  it("L5: the data-reset card title is neutral foreground (no destructive red)", () => {
    const html = render();
    // The reset card's title used to ship with `text-destructive`; the
    // v1.4.43 fix pins it on `text-foreground`. We don't care if other
    // strings in the section happen to use `text-destructive` (the CTA
    // button does), only that the specific card title slot does NOT.
    const cardMatch = html.match(
      /data-slot="settings-data-reset-card"[\s\S]*?<\/h2>/,
    );
    expect(cardMatch).not.toBeNull();
    expect(cardMatch![0]).toContain("text-foreground");
    expect(cardMatch![0]).not.toContain("text-destructive");
  });

  it("L5: the data-reset card no longer ships an AlertTriangle icon", () => {
    const html = render();
    // The icon used to render with a lucide-issued `lucide-alert-triangle`
    // class. Pin the absence; if a future revision re-imports the icon
    // the SVG class will reappear and this test catches it.
    const cardMatch = html.match(
      /data-slot="settings-data-reset-card"[\s\S]*?<\/h2>/,
    );
    expect(cardMatch).not.toBeNull();
    expect(cardMatch![0]).not.toMatch(/lucide-alert-triangle/);
  });

  it("M3: the account-delete card uses the destructive Button variant", () => {
    const html = render();
    expect(html).toContain('data-slot="settings-account-delete-trigger"');
    // The trigger button still wears the destructive style — the CTA
    // remains red even though the surrounding card chrome is neutral.
    const triggerMatch = html.match(
      /data-slot="settings-account-delete-trigger"[\s\S]*?<\/button>/,
    );
    expect(triggerMatch).not.toBeNull();
    // The destructive button uses the `bg-destructive` class from the
    // shadcn variant.
    expect(triggerMatch![0]).toContain("bg-destructive");
  });

  it("M3: the account-delete card surfaces tight DE copy under the 'de' locale", () => {
    const html = render("de");
    expect(html).toContain("Konto vollständig löschen");
    // The descriptive sentence calls out the cascade scope plainly.
    expect(html).toContain("Passkeys");
  });

  it("M3: the account-delete card surfaces tight EN copy under the 'en' locale", () => {
    const html = render("en");
    expect(html).toContain("Delete account entirely");
    expect(html).toContain("passkeys");
  });
});
