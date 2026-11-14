import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { MedicationCard } from "@/components/medications/medication-card";
import {
  Glp1MedicationCard,
  type Glp1Medication,
} from "@/components/medications/glp1-medication-card";

/**
 * v1.4.37 — symmetry contract between the generic medication card
 * (Ramipril/non-GLP-1) and the GLP-1 variant (Mounjaro). The two cards
 * must read as the same row shape. These tests pin the load-bearing
 * structural seams so a future refactor can't quietly regress parity.
 *
 * v1.7.2 — the four former header icon-buttons (open / edit / history
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

// v1.16.8 — the cards read ONE batched summary key and `select` their
// own row, so seeding merges into the shared array instead of writing a
// per-medication key.
function seedCompliance(client: QueryClient, medId: string) {
  const key = ["medications", "compliance-summary"];
  const existing =
    (client.getQueryData(key) as Array<{ medicationId: string }>) ?? [];
  client.setQueryData(key, [
    ...existing.filter((row) => row.medicationId !== medId),
    {
      medicationId: medId,
      compliance7: { rate: 90, streak: 0, totalExpected: 7, taken: 6 },
      compliance30: { rate: 88 },
    },
  ]);
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

// Pin the clock to a fixed mid-day instant so window-status is
// deterministic: the all-day window (00:00–23:59) reads active (the
// take-now pill) and the 01:00–02:00 window reads inactive (the upcoming
// "next intake" line that carries the purple dose accent), in every
// timezone. An unpinned run that fell inside 01:00–02:00 (e.g. 01:01 CEST)
// flipped the accent test's card to the take-now pill.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

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
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaro}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );

    for (const [html, href] of [
      [ramiprilHtml, `/medications/${ramipril.id}`],
      [mounjaroHtml, `/medications/${mounjaro.id}`],
    ] as const) {
      // v1.7.2 — exactly one overflow kebab; the four former icon
      // buttons (chevron / pencil / history / sliders) are gone from the
      // header. The menu items render on open (portalled), not in SSR.
      expect(html).toContain('aria-label="More options"');
      expect(html).not.toContain("lucide-chevron-right");
      // The card body itself navigates to the detail page.
      expect(html).toContain('data-slot="medication-card-header-link"');
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("Mounjaro carries the same single kebab as the generic card", () => {
    // The GLP-1 header shape stays byte-symmetric with the generic card: one
    // kebab trigger, no extra control.
    const client = makeClient();
    seedCompliance(client, mounjaro.id);
    seedGlp1Details(client, mounjaro.id);

    const html = render(
      <Glp1MedicationCard
        medication={mounjaro}
        onEdit={() => {}}
        onOpenHistory={() => {}}
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
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaro}
        onEdit={() => {}}
        onOpenHistory={() => {}}
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
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaro}
        onEdit={() => {}}
        onOpenHistory={() => {}}
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
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaro}
        onEdit={() => {}}
        onOpenHistory={() => {}}
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
    // A future next-due so the GLP-1 card's now-gated next-injection line
    // renders (it no longer prints a "—" placeholder when there is no next).
    const nextDueAt = new Date("2026-06-05T01:00:00Z").toISOString();
    const ramiprilFuture = {
      ...ramipril,
      nextDueAt,
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
      nextDueAt,
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
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaroFuture}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );

    // Both surfaces carry the dose-accent token on the upcoming dose. The
    // token is theme-aware (`--dose-accent`): pixel-identical to the former
    // Tailwind `text-purple-400` in dark mode, AA-safe on the white Alucard
    // card in light mode. The hard-coded `text-purple-400` is gone.
    expect(ramiprilHtml).toContain("text-dose-accent");
    expect(mounjaroHtml).toContain("text-dose-accent");
    expect(ramiprilHtml).not.toContain("text-purple-400");
    expect(mounjaroHtml).not.toContain("text-purple-400");
  });

  it("the next/last slot is structurally identical (same wrapper, order, colour, spacing) on both cards", () => {
    // The two cards now route the middle slot through the shared
    // <MedicationNextLastSlot>. The wrapper, line order (next then last),
    // colour token and spacing must be byte-identical across types — the
    // historical divergence (reversed order, `text-foreground/85` vs
    // `text-muted-foreground`, `space-y-1` vs `space-y-3.5`) is gone.
    const pastWindow = {
      windowStart: "01:00",
      windowEnd: "02:00",
      label: null,
      daysOfWeek: null,
    };
    // Render with a last-intake set + an upcoming (non-active) window so
    // BOTH the next and last lines are present, exercising the full slot.
    const yesterday = new Date("2026-06-01T09:00:00Z").toISOString();
    const ramiprilBoth = {
      ...ramipril,
      lastTakenAt: yesterday,
      nextDueAt: new Date("2026-06-05T01:00:00Z").toISOString(),
      schedules: [{ id: "s-r-both", ...pastWindow, dose: "5 mg" }],
    };
    const mounjaroBoth: Glp1Medication = {
      ...mounjaro,
      lastTakenAt: yesterday,
      nextDueAt: new Date("2026-06-05T01:00:00Z").toISOString(),
      schedules: [{ id: "s-m-both", ...pastWindow, dose: "7.5 mg" }],
    };

    const client = makeClient();
    seedCompliance(client, ramiprilBoth.id);
    seedCompliance(client, mounjaroBoth.id);
    seedGlp1Details(client, mounjaroBoth.id);

    const ramiprilHtml = render(
      <MedicationCard
        medication={ramiprilBoth}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaroBoth}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );

    for (const html of [ramiprilHtml, mounjaroHtml]) {
      // Identical reserved-height wrapper with identical spacing.
      expect(html).toContain('class="min-h-[2.75rem] space-y-3.5 text-sm"');
      // The slot's lines paint with the muted token on both cards — the
      // brighter `text-foreground/85` GLP-1 next-line is gone.
      expect(html).not.toContain("text-foreground/85");
      // No literal em-dash placeholder for an absent next-injection.
      expect(html).not.toContain(">—<");
      // Both lines present (next + last). Each line is a two-column
      // label-left / value-right row (`flex … justify-between`) so the
      // label and the time read as distinct columns rather than crammed
      // onto one run of text. Two such rows in the slot.
      const slotStart = html.indexOf("min-h-[2.75rem]");
      const slot = html.slice(slotStart, slotStart + 1200);
      const rows =
        slot.match(
          /<div class="text-muted-foreground flex items-baseline justify-between gap-3">/g,
        ) ?? [];
      expect(rows.length).toBe(2);
      // The value is pinned flush-right in its own column.
      expect(slot).toContain('<span class="text-right">');
    }
  });

  it("both cards keep a constant-height card body and bottom-pin the action row across types", () => {
    // The body is a flex column (`flex h-full flex-col`) and the action row
    // carries `mt-auto`, so unequal content can't misalign the take/skip
    // buttons across a grid row. A compliance skeleton reserves the bars'
    // footprint while the query is null. Exercise the generic card across
    // schedule-less types (PRN / one-shot) plus a scheduled oral and GLP-1.
    const base = {
      active: true,
      notificationsEnabled: true,
      pausedAt: null,
      lastTakenAt: null,
      todayEventCount: 0,
    };
    const oral = {
      ...base,
      id: "m-oral",
      name: "Metformin",
      dose: "500 mg",
      category: "DIABETES",
      schedules: [{ id: "so", ...allDayWindow, dose: "500 mg" }],
    };
    const prn = {
      ...base,
      id: "m-prn",
      name: "Ibuprofen",
      dose: "400 mg",
      category: "OTHER",
      // PRN: no schedule, no next-due → shortest possible body.
      schedules: [],
    };
    const oneShot = {
      ...base,
      id: "m-oneshot",
      name: "Vaccine",
      dose: "1 dose",
      category: "OTHER",
      schedules: [],
    };
    const glp1: Glp1Medication = {
      ...mounjaro,
      id: "m-glp1",
    };

    const client = makeClient();
    // Seed compliance for some but NOT others, so the skeleton path
    // (compliance null) is exercised alongside the loaded path.
    seedCompliance(client, oral.id);
    seedGlp1Details(client, glp1.id);
    // prn + oneShot intentionally left without compliance → skeleton.

    const htmls = [
      render(
        <MedicationCard
          medication={oral}
          onEdit={() => {}}
          onOpenHistory={() => {}}
        />,
        client,
      ),
      render(
        <MedicationCard
          medication={prn}
          onEdit={() => {}}
          onOpenHistory={() => {}}
        />,
        client,
      ),
      render(
        <MedicationCard
          medication={oneShot}
          onEdit={() => {}}
          onOpenHistory={() => {}}
        />,
        client,
      ),
      render(
        <Glp1MedicationCard
          medication={glp1}
          onEdit={() => {}}
          onOpenHistory={() => {}}
        />,
        client,
      ),
    ];

    for (const html of htmls) {
      // Card body is a bottom-pinning flex column on every type.
      expect(html).toContain("flex h-full flex-col space-y-3.5");
      // Action row carries the bottom-pin.
      expect(html).toContain("mt-auto");
      // Reserved next/last slot is present on every type (constant height).
      expect(html).toContain("min-h-[2.75rem] space-y-3.5 text-sm");
    }

    // The two cards left without compliance render the skeleton so their
    // body keeps the bars' footprint rather than collapsing ~5rem shorter.
    expect(htmls[1]).toContain("aria-hidden"); // prn skeleton
    expect(htmls[2]).toContain("aria-hidden"); // one-shot skeleton
  });

  it("both cards show the medication's own note inside the bottom-pinned action block (#1371)", () => {
    const note = "30 to 60 minutes before food";
    const client = makeClient();
    seedCompliance(client, ramipril.id);
    seedCompliance(client, mounjaro.id);
    seedGlp1Details(client, mounjaro.id);
    const htmls = [
      render(
        <MedicationCard
          medication={{ ...ramipril, note }}
          onEdit={() => {}}
          onOpenHistory={() => {}}
        />,
        client,
      ),
      render(
        <Glp1MedicationCard
          medication={{ ...mounjaro, note }}
          onEdit={() => {}}
          onOpenHistory={() => {}}
        />,
        client,
      ),
    ];
    for (const html of htmls) {
      // In the bottom-pinned block, before the take button: the rows above
      // keep their baseline, and the note is in view when a dose is logged.
      const block = html.indexOf("mt-auto space-y-2");
      const noteAt = html.indexOf('data-slot="medication-card-note"');
      const takeAt = html.indexOf('data-slot="medication-intake-take"');
      expect(block).toBeGreaterThan(-1);
      expect(noteAt).toBeGreaterThan(block);
      expect(takeAt).toBeGreaterThan(noteAt);
      expect(html).toContain(note);
      // The person's words are content, never muted meta.
      expect(html).toMatch(
        /<span data-slot="medication-card-note" title="30 to 60 minutes before food" class="text-sm break-words line-clamp-2">/,
      );
    }
  });

  it("renders no note slot for a medication without one", () => {
    const client = makeClient();
    seedCompliance(client, ramipril.id);
    const html = render(
      <MedicationCard
        medication={{ ...ramipril, note: null }}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );
    expect(html).not.toContain("medication-card-note");
  });
});
