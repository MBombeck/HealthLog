import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { SideEffectsSection } from "@/components/medications/SideEffectsSection";

/**
 * v1.4.25 W19d — SideEffectsSection SSR smoke tests.
 *
 * The project never installed `@testing-library/react`; the
 * convention is `renderToStaticMarkup` + assertions against the SSR
 * string, with react-query data seeded via `QueryClient.setQueryData()`
 * so the section's `useQuery` resolves synchronously. Interactive
 * branches (submit, delete, dialog open) are covered by the API-route
 * tests + the pure taxonomy tests; the surface tests here pin the
 * static-render contract:
 *
 *   1. Section heading + add-CTA render in both locales.
 *   2. Empty state copy when no rows are seeded.
 *   3. Recent-30-days timeline renders entries with category badge,
 *      entry label, severity label, and notes.
 *   4. Severity translation passes through the Likert ladder.
 *   5. Category badge translation uses the i18n category key.
 */

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Synchronous resolution of seeded data is the test contract.
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
      },
    },
  });
}

function seedSideEffects(
  client: QueryClient,
  medId: string,
  rows: Array<{
    id: string;
    category: string;
    entry: string;
    severity: number;
    occurredAt: string;
    notes: string | null;
  }>,
) {
  client.setQueryData(["medications", medId, "side-effects", "list"], {
    items: rows,
    meta: { total: rows.length },
  });
}

function render(
  node: React.ReactNode,
  client: QueryClient,
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<SideEffectsSection> — surface render", () => {
  it("renders the section heading and add-CTA in English", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", []);
    const html = render(<SideEffectsSection medicationId="med-1" />, client);
    expect(html).toContain("Side effects");
    expect(html).toContain("Log side effect");
  });

  it("renders the section heading and add-CTA in German", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", []);
    const html = render(
      <SideEffectsSection medicationId="med-1" />,
      client,
      "de",
    );
    expect(html).toContain("Nebenwirkungen");
    expect(html).toContain("Nebenwirkung erfassen");
  });

  it("renders the empty-state copy when no rows are seeded", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", []);
    const html = render(<SideEffectsSection medicationId="med-1" />, client);
    expect(html).toContain("No side effects logged yet");
  });
});

describe("<SideEffectsSection> — timeline rows", () => {
  it("renders entry label, category badge, and severity label", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", [
      {
        id: "se-1",
        category: "GI",
        entry: "NAUSEA",
        severity: 2,
        occurredAt: "2026-05-13T08:00:00.000Z",
        notes: null,
      },
    ]);
    const html = render(<SideEffectsSection medicationId="med-1" />, client);
    expect(html).toContain("Nausea");
    expect(html).toContain("Gastrointestinal");
    expect(html).toContain("Moderate");
  });

  it("renders multi-category rows independently", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", [
      {
        id: "se-1",
        category: "GI",
        entry: "NAUSEA",
        severity: 1,
        occurredAt: "2026-05-13T08:00:00.000Z",
        notes: null,
      },
      {
        id: "se-2",
        category: "GLP1_SPECIFIC",
        entry: "EARLY_SATIETY",
        severity: 4,
        occurredAt: "2026-05-12T08:00:00.000Z",
        notes: "felt full after two bites",
      },
    ]);
    const html = render(<SideEffectsSection medicationId="med-1" />, client);
    expect(html).toContain("Nausea");
    expect(html).toContain("Mild");
    expect(html).toContain("Early satiety");
    expect(html).toContain("GLP-1 specific");
    expect(html).toContain("Severe");
    expect(html).toContain("felt full after two bites");
  });

  it("shows the recent-30-days label when items are present", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", [
      {
        id: "se-1",
        category: "COGNITIVE",
        entry: "BRAIN_FOG",
        severity: 3,
        occurredAt: "2026-05-13T08:00:00.000Z",
        notes: null,
      },
    ]);
    const html = render(<SideEffectsSection medicationId="med-1" />, client);
    expect(html).toContain("Last 30 days");
  });

  it("translates the severity-label ladder via the i18n helper", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", [
      {
        id: "a",
        category: "GI",
        entry: "NAUSEA",
        severity: 1,
        occurredAt: "2026-05-13T08:00:00.000Z",
        notes: null,
      },
      {
        id: "b",
        category: "GI",
        entry: "VOMITING",
        severity: 5,
        occurredAt: "2026-05-13T09:00:00.000Z",
        notes: null,
      },
    ]);
    const html = render(<SideEffectsSection medicationId="med-1" />, client);
    expect(html).toContain("Mild");
    expect(html).toContain("Very severe");
  });

  it("renders German entry and category labels when locale=de", () => {
    const client = makeClient();
    seedSideEffects(client, "med-1", [
      {
        id: "se-1",
        category: "INJECTION_SITE",
        entry: "INJECTION_REDNESS",
        severity: 2,
        occurredAt: "2026-05-13T08:00:00.000Z",
        notes: null,
      },
    ]);
    const html = render(
      <SideEffectsSection medicationId="med-1" />,
      client,
      "de",
    );
    expect(html).toContain("Injektionsstelle");
    expect(html).toContain("Rötung Einstichstelle");
    expect(html).toContain("Mittel");
  });
});
