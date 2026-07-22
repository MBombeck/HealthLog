import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import de from "../../../../messages/de.json";
import en from "../../../../messages/en.json";

/**
 * v1.4.15 phase-C5 — `/admin/backups` empty state.
 *
 * The previous build rendered a single-line `<p>No backups recorded
 * yet.</p>` inside the card. Brand-new admins didn't realise the "Run
 * backup now" CTA in the header was the way to create one, so the page
 * felt inert. The new EmptyState primitive duplicates the header CTA
 * inside the card so the action is right next to the explanation.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/backups",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { rows: [], retentionDays: 30 },
    isLoading: false,
    isError: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    variables: undefined,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "testuser", role: "ADMIN" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { BackupsSection } from "../backups-section";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <BackupsSection />
    </I18nProvider>,
  );
}

describe("BackupsSection — empty state", () => {
  it("renders the EmptyState primitive when no backups exist", () => {
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("border-dashed");
  });

  it("includes the localized title and description", () => {
    const html = render();
    expect(html).toContain("No backups yet");
    expect(html).toContain("Backups run automatically every Sunday at 03:00");
  });

  it("exposes the Backup-now CTA inside the empty card", () => {
    const html = render();
    // The header's CTA is also "Backup now"; the empty-state CTA must
    // appear AT LEAST TWICE — once in the header, once inside the
    // empty card. If the empty card forgets the action we'd see only
    // one occurrence.
    const matches = (html.match(/Backup now/g) ?? []).length;
    expect(matches).toBeGreaterThanOrEqual(2);
  });

  it("uses the full muted semantic color for localized upload help", () => {
    const english = render();
    const german = render("de");
    const helpElement = english.match(
      /<[^>]+data-slot="backup-upload-help"[^>]*>/,
    )?.[0];
    const className = helpElement?.match(/\bclass="([^"]*)"/)?.[1] ?? "";

    expect(english).toContain(
      "JSON file matching the current backup schema. Max 10 MB.",
    );
    expect(german).toContain(
      "JSON-Datei passend zum aktuellen Backup-Schema. Max. 10 MB.",
    );
    expect(helpElement).toBeDefined();
    expect(className.split(/\s+/)).toContain("text-muted-foreground");
    expect(className).not.toMatch(/\b(?:opacity-\d+|text-\S+\/\d+)\b/);
  });

  it("warns in both catalogs that restore overwrites instance-wide settings", () => {
    expect(de.admin.section.backups.restoreDescription).toMatch(
      /instanzweite Einstellungen/i,
    );
    expect(en.admin.section.backups.restoreDescription).toMatch(
      /instance-wide settings/i,
    );
  });
});
