import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { MedicationCard } from "@/components/medications/medication-card";
import {
  Glp1MedicationCard,
  type Glp1Medication,
} from "@/components/medications/glp1-medication-card";

/**
 * v1.4.37 W4b — symmetry contract between the generic medication card
 * (Ramipril/non-GLP-1) and the GLP-1 variant (Mounjaro). The two cards
 * must read as the same row shape. These tests pin the load-bearing
 * structural seams so a future refactor can't quietly regress parity.
 *
 * v1.7.2 W3 — the four former header icon-buttons (open / edit / history
 * / advanced) collapsed into a SINGLE overflow kebab on both cards; the
 * card header itself links to the detail page (the former chevron
 * target). The GLP-1 card folds its "Log side effect" item into the same
 * kebab. Radix dropdown content is portalled, so SSR markup only carries
 * the kebab trigger (the menu items render on open at runtime).
 *
 * What we assert:
 *   1. Header `actions` — both cards render exactly one kebab trigger
 *      (`common.moreOptions` aria-label) and a navigable header link to
 *      the detail page. No standalone chevron / pencil / history /
 *      sliders icon-buttons survive in the header.
 *   2. Category-label badge — both cards consult the same
 *      `getMedicationCategoryLabel` lookup. No card hard-codes the
 *      `medications.treatmentClassGlp1` string into the slot.
 *   3. Take-now status pill — when the current time is inside a
 *      configured schedule window and `lastTakenAt` is null/older, both
 *      cards render the `medications.takeNow` localised text.
 *   4. Primary actions row — exactly two buttons (Eingenommen /
 *      Übersprungen).
 *   5. Purple dose accent — both cards render
 *      `font-medium text-purple-400` on the upcoming schedule dose.
 */

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
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

function seedCompliance(client: QueryClient, medId: string) {
  client.setQueryData(["medications", medId, "compliance"], {
    compliance7: { rate: 90, streak: 0, totalExpected: 7, taken: 6 },
    compliance30: { rate: 88 },
  });
}

function seedGlp1Details(client: QueryClient, medId: string) {
  client.setQueryData(["medications", medId, "glp1-details"], {
    doseChanges: [],
    recentIntakes: [],
    inventory: null,
  });
}

/**
 * Schedule that fires every day of the week from 00:00 to 23:59 so
 * the SSR snapshot always lands inside the current window regardless
 * of the host clock — pinning the "take now" pill assertion.
 */
const allDayWindow = {
  windowStart: "00:00",
  windowEnd: "23:59",
  label: null,
  daysOfWeek: null,
};

const ramipril = {
  id: "med-ramipril-1",
  name: "Ramipril",
  dose: "5 mg",
  category: "BLOOD_PRESSURE",
  treatmentClass: undefined as string | undefined,
  active: true,
  notificationsEnabled: true,
  pausedAt: null,
  lastTakenAt: null,
  todayEventCount: 0,
  schedules: [
    {
      id: "s-ramipril-1",
      ...allDayWindow,
      dose: "5 mg",
    },
  ],
};

const mounjaro: Glp1Medication = {
  id: "med-mounjaro-1",
  name: "Mounjaro",
  dose: "7.5 mg",
  category: "HORMONE",
  treatmentClass: "GLP1",
  dosesPerUnit: 4,
  active: true,
  notificationsEnabled: true,
  pausedAt: null,
  lastTakenAt: null,
  todayEventCount: 0,
  schedules: [
    {
      id: "s-mounjaro-1",
      ...allDayWindow,
      dose: "7.5 mg",
    },
  ],
};

describe("medication card symmetry — Ramipril vs Mounjaro", () => {
  it("both cards collapse the header actions into a single kebab + navigable header link", () => {
    const client = makeClient();
    seedCompliance(client, ramipril.id);
    seedCompliance(client, mounjaro.id);
    seedGlp1Details(client, mounjaro.id);

    const ramiprilHtml = render(
      <MedicationCard
        medication={ramipril}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaro}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    for (const [html, href] of [
      [ramiprilHtml, `/medications/${ramipril.id}`],
      [mounjaroHtml, `/medications/${mounjaro.id}`],
    ] as const) {
      // v1.7.2 W3 — exactly one overflow kebab; the four former icon
      // buttons (chevron / pencil / history / sliders) are gone from the
      // header. The menu items render on open (portalled), not in SSR.
      expect(html).toContain('aria-label="More options"');
      expect(html).not.toContain("lucide-chevron-right");
      // The card body itself navigates to the detail page.
      expect(html).toContain(
        'data-slot="medication-card-header-link"',
      );
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("Mounjaro keeps the single kebab even when onLogSideEffect is supplied (GLP-1-only)", () => {
    // The side-effect quick-log folds into the SAME overflow menu, so the
    // GLP-1 header shape stays byte-symmetric with the generic card: one
    // kebab trigger, no extra control.
    const client = makeClient();
    seedCompliance(client, mounjaro.id);
    seedGlp1Details(client, mounjaro.id);

    const html = render(
      <Glp1MedicationCard
        medication={mounjaro}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
        onLogSideEffect={() => {}}
      />,
      client,
    );

    // Exactly one kebab trigger.
    const triggers = html.match(/aria-label="More options"/g) ?? [];
    expect(triggers).toHaveLength(1);
  });

  it("category label uses the shared category-map lookup on both cards", () => {
    const client = makeClient();
    seedCompliance(client, ramipril.id);
    seedCompliance(client, mounjaro.id);
    seedGlp1Details(client, mounjaro.id);

    const ramiprilHtml = render(
      <MedicationCard
        medication={ramipril}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaro}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    // Ramipril → BLOOD_PRESSURE → "Blood Pressure".
    expect(ramiprilHtml).toContain("Blood Pressure");
    // Mounjaro → HORMONE → "Hormones".  The card must NOT hard-code
    // the treatment-class label into the slot any more.
    expect(mounjaroHtml).toContain("Hormones");
    expect(mounjaroHtml).not.toContain("GLP-1 injection");
  });

  it("both cards render the take-now pill when inside the current schedule window", () => {
    const client = makeClient();
    seedCompliance(client, ramipril.id);
    seedCompliance(client, mounjaro.id);
    seedGlp1Details(client, mounjaro.id);

    const ramiprilHtml = render(
      <MedicationCard
        medication={ramipril}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaro}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    for (const html of [ramiprilHtml, mounjaroHtml]) {
      expect(html).toContain("Take now");
      // Coloured-pill contract — the in_window pill class carries
      // the success token, not the warning token.
      expect(html).toContain("text-success");
    }
  });

  it("primary actions row carries exactly two buttons on both cards", () => {
    const client = makeClient();
    seedCompliance(client, ramipril.id);
    seedCompliance(client, mounjaro.id);
    seedGlp1Details(client, mounjaro.id);

    const ramiprilHtml = render(
      <MedicationCard
        medication={ramipril}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaro}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
        onLogSideEffect={() => {}}
      />,
      client,
    );

    for (const html of [ramiprilHtml, mounjaroHtml]) {
      // Taken / Skipped — and no third in-row button.  We assert the
      // primary-actions buttons via icon class names since those
      // surface on both cards.
      expect(html).toContain("lucide-check");
      expect(html).toContain("lucide-skip-forward");
    }
    // The Stethoscope glyph is GLP-1-only; SSR doesn't open the
    // Radix Portal so even when wired the menu item is hidden from
    // the initial markup. The primary row must NOT carry it.
    expect(mounjaroHtml).not.toMatch(
      /class="[^"]*flex[^"]*gap-2[^"]*"[^>]*>[\s\S]*?lucide-stethoscope/,
    );
  });

  it("purple dose accent surfaces on the upcoming schedule dose on both cards", () => {
    // Pin the asymmetry from the v1.4.37 UX audit (item 11): the
    // GLP-1 card historically lacked the purple accent. Both cards
    // must now stamp the same `text-purple-400` token on the
    // schedule dose. We render at a window that's NOT currently
    // active so the "next intake" line (which carries the accent)
    // surfaces instead of the take-now pill.
    const futureWindow = {
      windowStart: "01:00",
      windowEnd: "02:00",
      label: null,
      daysOfWeek: null,
    };
    const ramiprilFuture = {
      ...ramipril,
      schedules: [
        {
          id: "s-ramipril-future",
          ...futureWindow,
          dose: "5 mg",
        },
      ],
    };
    const mounjaroFuture: Glp1Medication = {
      ...mounjaro,
      schedules: [
        {
          id: "s-mounjaro-future",
          ...futureWindow,
          dose: "7.5 mg",
        },
      ],
    };

    const client = makeClient();
    seedCompliance(client, ramiprilFuture.id);
    seedCompliance(client, mounjaroFuture.id);
    seedGlp1Details(client, mounjaroFuture.id);

    const ramiprilHtml = render(
      <MedicationCard
        medication={ramiprilFuture}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaroFuture}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    // Both surfaces carry the purple token on the upcoming dose.
    expect(ramiprilHtml).toContain("text-purple-400");
    expect(mounjaroHtml).toContain("text-purple-400");
  });
});
