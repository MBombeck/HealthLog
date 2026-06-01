import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import {
  Glp1MedicationCard,
  type Glp1Medication,
} from "@/components/medications/glp1-medication-card";
import { MedicationCard } from "@/components/medications/medication-card";

/**
 * v1.4.25 W4d-tests — RTL-style component coverage for the GLP-1
 * medication-card variant deferred by phase W4d.
 *
 * The project never installed `@testing-library/react`; the convention
 * is `renderToStaticMarkup` + assertions against the SSR string, with
 * react-query data seeded via `QueryClient.setQueryData()` so the
 * card's `useQuery` calls resolve synchronously. Interactive behaviour
 * (button onClick → callback) is smoke-checked by invoking the
 * supplied handler directly — SSR can't fire DOM events.
 *
 * Test cases (per phase-W4d-v1425-glp1-full-report.md "Tests deferred"):
 *   1. Renders GLP-1 variant when treatmentClass === "GLP1"
 *   2. Renders default MedicationCard when treatmentClass === null
 *   3. Drug name + current dose ("Mounjaro · 7.5 mg") visible
 *   4. Last + next injection labels with localised weekday
 *   5. Inline dose-history disclosure (closed by default)
 *   6. Injection-site rotation marker (last + recommended)
 *   7. Pen-inventory line when data present
 *   8. Side-effect quick-log button hands off the medication object
 *      (the parent wires this to MoodEntry with a pre-filled tag)
 *   9. AI-disabled state: the GLP-1 Coach hand-off button (deferred —
 *      not yet implemented; if/when it lands it must respect the
 *      provider-configured gate). This test pins the current absence.
 */

const med7p5: Glp1Medication = {
  id: "med-glp1-1",
  name: "Mounjaro",
  dose: "7.5 mg",
  category: "OTHER",
  treatmentClass: "GLP1",
  dosesPerUnit: 4,
  active: true,
  notificationsEnabled: true,
  pausedAt: null,
  // ~3 days ago so "last injection" reads as a recent absolute date,
  // not "today/yesterday" — keeps the SSR string deterministic-ish
  // across local clocks while still exercising the with-site branch.
  lastTakenAt: "2026-05-08T08:00:00.000Z",
  schedules: [
    {
      id: "s1",
      // Saturday only — one entry triggers the weekly-preset branch
      // in `predictNextWeeklyDate()`.
      windowStart: "08:00",
      windowEnd: "20:00",
      label: null,
      dose: "7.5 mg",
      daysOfWeek: "6",
    },
  ],
};

const defaultMed = {
  id: "med-bp-1",
  name: "Ramipril",
  dose: "5 mg",
  category: "BLOOD_PRESSURE",
  treatmentClass: undefined as string | undefined,
  active: true,
  notificationsEnabled: true,
  pausedAt: null,
  lastTakenAt: null,
  schedules: [
    {
      id: "s2",
      windowStart: "07:30",
      windowEnd: "09:30",
      label: null,
      dose: null,
      daysOfWeek: null,
    },
  ],
};

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
}

/**
 * Seed both queries the card consumes (compliance + glp1 details) so
 * the first SSR pass already has data — TanStack Query returns
 * cached data synchronously when present, even on the server.
 */
function seedGlp1Details(
  client: QueryClient,
  medId: string,
  details: {
    doseChanges?: Array<{
      id: string;
      effectiveFrom: string;
      doseValue: number;
      doseUnit: string;
      note: string | null;
    }>;
    recentIntakes?: Array<{
      takenAt: string | null;
      injectionSite: string | null;
    }>;
    inventory?: {
      pensRemaining: number | null;
      dosesRemaining: number | null;
      weeksOfSupply: number | null;
      lowStock: boolean;
    } | null;
  },
) {
  client.setQueryData(["medications", medId, "glp1-details"], {
    doseChanges: details.doseChanges ?? [],
    recentIntakes: details.recentIntakes ?? [],
    inventory: details.inventory ?? null,
  });
}

function seedCompliance(
  client: QueryClient,
  medId: string,
  payload: {
    rate7?: number;
    rate30?: number;
    streak?: number;
  } = {},
) {
  client.setQueryData(["medications", medId, "compliance"], {
    compliance7: {
      rate: payload.rate7 ?? 85,
      streak: payload.streak ?? 0,
    },
    compliance30: { rate: payload.rate30 ?? 82 },
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

describe("<Glp1MedicationCard> — GLP-1 variant rendering", () => {
  it("renders the GLP-1 variant when treatmentClass === 'GLP1' is active", () => {
    // v1.4.37 W4b — the category-label slot now mirrors the generic
    // card (real `medication.category` lookup) so Ramipril and
    // Mounjaro share the same row shape. The variant differentiator
    // moved into the GLP-1-specific rows below the header (last/next
    // injection, rotation hint). We verify the GLP-1 card no longer
    // hard-codes the treatment-class label into the category slot,
    // and that the actual category lookup wins.
    const client = makeClient();
    seedCompliance(client, med7p5.id);
    seedGlp1Details(client, med7p5.id, {});

    const html = render(
      <Glp1MedicationCard
        medication={med7p5}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    // Category is OTHER → "Other" badge wins.
    expect(html).toContain("Other");
    expect(html).not.toContain("GLP-1 injection");
    // v1.4.28 FB-G1 — the Syringe glyph + middle-dot separator on the
    // list row are gone. The list row reads as the canonical two-line
    // shape: `{name} {dose}` on line 1, class label on line 2.
    expect(html).not.toMatch(/lucide-syringe/i);
  });

  it("collapses edit / history / advanced into a single overflow kebab + navigable header", () => {
    // v1.7.2 W3 — the four former header icon-buttons collapse into one
    // kebab; the card header links to the detail page. The menu items
    // (edit / history / advanced) render inside the portalled dropdown
    // content, so SSR markup carries only the kebab trigger + the header
    // link, not the individual action buttons.
    const client = makeClient();
    seedCompliance(client, med7p5.id);
    seedGlp1Details(client, med7p5.id, {});

    const onEdit = vi.fn();
    const onOpenHistory = vi.fn();
    const onOpenAdvanced = vi.fn();

    const html = render(
      <Glp1MedicationCard
        medication={med7p5}
        onEdit={onEdit}
        onOpenHistory={onOpenHistory}
        onOpenAdvanced={onOpenAdvanced}
      />,
      client,
    );

    expect(html).toContain('aria-label="More options"');
    expect(html).toContain('data-slot="medication-card-header-link"');
    expect(html).toContain('href="/medications/med-glp1-1"');
    // No standalone chevron / sliders icon-buttons survive in the header.
    expect(html).not.toContain("lucide-chevron-right");

    // Smoke-check the handler contract — SSR can't fire DOM events, so
    // invoke the handlers the way each menu item's onClick would and pin
    // the medication-object payload the parent routes / sheets against.
    onOpenHistory(med7p5);
    onOpenAdvanced(med7p5);
    expect(onOpenHistory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "med-glp1-1", treatmentClass: "GLP1" }),
    );
    expect(onOpenAdvanced).toHaveBeenCalledWith(
      expect.objectContaining({ id: "med-glp1-1", treatmentClass: "GLP1" }),
    );
  });

  it("renders the default MedicationCard when treatmentClass is null/undefined (back-compat)", () => {
    // The page dispatcher renders MedicationCard for everything that
    // isn't `"GLP1"`. We verify the default card's output stays free
    // of the GLP-1-specific badge so legacy mocks (no treatmentClass
    // field) keep producing the v1.4.24 UI.
    const client = makeClient();
    seedCompliance(client, defaultMed.id);

    const html = render(
      <MedicationCard
        medication={defaultMed}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    // Default card shows the localised category label, not the
    // GLP-1 badge.
    expect(html).toContain("Blood Pressure");
    expect(html).not.toContain("GLP-1 injection");
    expect(html).not.toMatch(/lucide-syringe/i);
    // The dose-history disclosure is GLP-1-only; default card omits it.
    expect(html).not.toContain("Dose history");
  });

  it("shows drug name + current dose on line 1 ('Mounjaro 7.5 mg')", () => {
    const client = makeClient();
    seedCompliance(client, med7p5.id);
    seedGlp1Details(client, med7p5.id, {});

    const html = render(
      <Glp1MedicationCard
        medication={med7p5}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    expect(html).toContain("Mounjaro");
    expect(html).toContain("7.5 mg");
    // v1.4.28 FB-G1 — the GLP-1 row drops the middle-dot separator and
    // surfaces `{name} {dose}` together on line 1 via the shared
    // `<MedicationCardHeader>` primitive. The dot separator is gone.
    expect(html).toContain("Mounjaro 7.5 mg");
  });

  it("shows last + next injection labels with localised weekday", () => {
    const client = makeClient();
    seedCompliance(client, med7p5.id);
    seedGlp1Details(client, med7p5.id, {
      recentIntakes: [
        { takenAt: med7p5.lastTakenAt, injectionSite: "ABDOMEN_LEFT" },
      ],
    });

    const html = render(
      <Glp1MedicationCard
        medication={med7p5}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    // The with-site copy reads "Last: <label> · <site>"; both halves
    // must show up in the SSR string.
    expect(html).toContain("Last:");
    expect(html).toContain("Abdomen, lower left");
    // The next-injection helper produces one of three strings — today,
    // tomorrow, or "in N days". All three contain the localised "Next:"
    // prefix from `glp1NextInjection*` keys.
    expect(html).toMatch(/Next:/);
  });

  it("no longer renders the inline dose-history disclosure (retired v1.4.28)", () => {
    // The dose-history `<details>` block was retired in v1.4.28 per
    // maintainer feedback. The doseChanges payload still arrives from
    // the API (iOS contract preserved), but the GLP-1 card no longer
    // paints the disclosure or the summary label.
    const client = makeClient();
    seedCompliance(client, med7p5.id);
    seedGlp1Details(client, med7p5.id, {
      doseChanges: [
        {
          id: "dc-1",
          effectiveFrom: "2026-02-01",
          doseValue: 5,
          doseUnit: "mg",
          note: null,
        },
        {
          id: "dc-2",
          effectiveFrom: "2026-04-01",
          doseValue: 7.5,
          doseUnit: "mg",
          note: null,
        },
      ],
    });

    const html = render(
      <Glp1MedicationCard
        medication={med7p5}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    expect(html).not.toContain("Dose history");
    expect(html).not.toContain("Dosis-Historie");
  });

  it("renders the injection-site rotation marker (last + recommended)", () => {
    // The rotation hint surfaces only when `lastSite` and the
    // recommender disagree. We feed a left-cluster history → the
    // recommender lands on a right-side or thigh/arm site, so the
    // hint card renders.
    const client = makeClient();
    seedCompliance(client, med7p5.id);
    seedGlp1Details(client, med7p5.id, {
      recentIntakes: [
        { takenAt: "2026-05-08T08:00:00Z", injectionSite: "ABDOMEN_LEFT" },
        {
          takenAt: "2026-05-01T08:00:00Z",
          injectionSite: "ABDOMEN_UPPER_LEFT",
        },
      ],
    });

    const html = render(
      <Glp1MedicationCard
        medication={med7p5}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    expect(html).toContain("Last site:");
    expect(html).toContain("Recommended next:");
    // Last site is the most-recent intake site.
    expect(html).toContain("Abdomen, lower left");
  });

  it("no longer renders the pen-inventory line (retired v1.4.28)", () => {
    // The maintainer retired the entire Bestand / inventory surface
    // on the GLP-1 card in v1.4.28. The iOS-consumed Glp1InventoryDTO
    // slot stays in the response shape, but the web card never paints
    // the inline pens-remaining line or the low-stock badge any more.
    const client = makeClient();
    seedCompliance(client, med7p5.id);
    seedGlp1Details(client, med7p5.id, {
      inventory: {
        pensRemaining: 2,
        dosesRemaining: 8,
        weeksOfSupply: 8,
        lowStock: false,
      },
    });

    const html = render(
      <Glp1MedicationCard
        medication={med7p5}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    expect(html).not.toContain("pens left");
    expect(html).not.toContain("Low stock");
  });

  it("does not render the low-stock badge even when inventory.lowStock is true (retired v1.4.28)", () => {
    const client = makeClient();
    seedCompliance(client, med7p5.id);
    seedGlp1Details(client, med7p5.id, {
      inventory: {
        pensRemaining: 1,
        dosesRemaining: 3,
        weeksOfSupply: 3,
        lowStock: true,
      },
    });

    const html = render(
      <Glp1MedicationCard
        medication={med7p5}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    expect(html).not.toContain("pens left");
    expect(html).not.toContain("Low stock");
  });

  it("folds the side-effect quick-log into the same overflow kebab", () => {
    // v1.7.2 W3 — the side-effect quick-log folds into the SAME overflow
    // menu as edit / history / advanced, so the GLP-1 header carries one
    // kebab whether or not the hand-off is wired (parity with the generic
    // card). SSR doesn't open Radix Portal content, so we assert the
    // single trigger surfaces and smoke-check the handler payload.
    const client = makeClient();
    seedCompliance(client, med7p5.id);
    seedGlp1Details(client, med7p5.id, {});

    const handler = vi.fn();
    const html = render(
      <Glp1MedicationCard
        medication={med7p5}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
        onLogSideEffect={handler}
      />,
      client,
    );

    // Exactly one kebab trigger with the localised aria-label.
    const triggers = html.match(/aria-label="More options"/g) ?? [];
    expect(triggers).toHaveLength(1);
    // The side-effect button must no longer ride alongside
    // Eingenommen / Übersprungen in the primary actions row.
    expect(html).not.toMatch(
      /class="[^"]*flex[^"]*gap-2[^"]*"[^>]*>[\s\S]*?Log side effect/,
    );

    // Invoke the supplied handler the way the menu item's onClick
    // would — pins the prefill payload contract for MoodEntry.
    handler(med7p5);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Mounjaro", treatmentClass: "GLP1" }),
    );
  });

  it("still renders the single kebab when onLogSideEffect is not supplied", () => {
    // v1.7.2 W3 — the kebab is unconditional now (it always carries edit
    // / history / advanced); the side-effect item is the only opt-in
    // part. Mounjaro and Ramipril therefore share the same one-kebab
    // header shape regardless of the hand-off prop.
    const client = makeClient();
    seedCompliance(client, med7p5.id);
    seedGlp1Details(client, med7p5.id, {});

    const html = render(
      <Glp1MedicationCard
        medication={med7p5}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    expect(html).toContain('aria-label="More options"');
  });

  it("AI-disabled state: no Coach hand-off button is rendered today", () => {
    // The phase-W4d brief reserves a "Coach hand-off button (if
    // present)" slot on the GLP-1 card. It has not landed in v1.4.25
    // — the GLP-1 Coach context flows through the global Coach via
    // GROUND RULE 9, not a per-card button. This test pins the
    // current absence so a future hand-off button that doesn't
    // respect the `aiEnabled` gate is caught by the suite.
    const client = makeClient();
    seedCompliance(client, med7p5.id);
    seedGlp1Details(client, med7p5.id, {});

    const html = render(
      <Glp1MedicationCard
        medication={med7p5}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    // No "Ask Coach" / "Coach" / "Ask AI" CTA on the card surface.
    expect(html).not.toMatch(/data-slot=["']glp1-coach-handoff["']/);
    expect(html).not.toMatch(/Ask Coach/i);
  });

  it("renders inactive state when medication is paused", () => {
    const paused: Glp1Medication = {
      ...med7p5,
      active: false,
      pausedAt: "2026-05-10T00:00:00.000Z",
    };
    const client = makeClient();
    seedCompliance(client, paused.id);
    seedGlp1Details(client, paused.id, {});

    const html = render(
      <Glp1MedicationCard
        medication={paused}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    // Paused-since badge replaces the primary actions; the card
    // greys out via the `opacity-60` class on the Card shell.
    expect(html).toContain("opacity-60");
    expect(html).toContain("Paused since");
    // Primary actions ("Taken" / "Skipped") are suppressed for
    // inactive medications, but the header overflow kebab (edit /
    // history / advanced) still renders so the user can reach those
    // actions on a paused medication.
    expect(html).toContain('aria-label="More options"');
  });

  it("renders German copy under the 'de' locale", () => {
    // I18n smoke check — confirms the GLP-1 surface uses the t()
    // path consistently. The German Umlaut "ä" round-trips through
    // the JSON import + SSR pipeline.
    const client = makeClient();
    seedCompliance(client, med7p5.id);
    seedGlp1Details(client, med7p5.id, {
      recentIntakes: [
        { takenAt: med7p5.lastTakenAt, injectionSite: "ABDOMEN_LEFT" },
      ],
    });

    const html = render(
      <Glp1MedicationCard
        medication={med7p5}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
      "de",
    );

    // v1.4.37 W4b — the German category badge now comes from the
    // shared category-label lookup (Sonstiges for OTHER) instead of
    // the hard-coded "GLP-1-Injektion" label, so the GLP-1 card stays
    // visually symmetric with the generic card on the medications list.
    expect(html).toContain("Sonstiges");
    expect(html).not.toContain("GLP-1-Injektion");
    expect(html).toContain("Letzter Termin:");
    expect(html).toContain("Bauch, unten links");
    // v1.4.28 retired the "Dosis-Historie" disclosure on the GLP-1 card.
    expect(html).not.toContain("Dosis-Historie");
  });
});
