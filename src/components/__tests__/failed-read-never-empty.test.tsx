import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import en from "../../../messages/en.json";

/**
 * A failed read must never render as an absence of data.
 *
 * "No data yet" is a factual claim about the user's record. Making it when the
 * read failed is a false statement about their health history — worst of all on
 * the mental-wellbeing surface, where a user with months of screening results
 * was told, in a mental-health context, that they had never taken an
 * assessment.
 *
 * Each surface must tell three states apart: loading, failed, and genuinely
 * empty. These tests pin the failed/empty split; the loading branch is asserted
 * where it is SSR-observable.
 *
 * SSR-only convention (`renderToStaticMarkup`, no `@testing-library/react`), so
 * the error state is produced by seeding the query cache with a settled failure
 * rather than by driving a real fetch.
 */

vi.mock("@/lib/api/api-fetch", async (importOriginal) => ({
  // `ApiError` stays real: the error primitives read its status.
  ApiError: (await importOriginal<typeof import("@/lib/api/api-fetch")>())
    .ApiError,
  apiGet: () => new Promise(() => {}),
  apiPost: () => new Promise(() => {}),
}));

vi.mock("@/hooks/use-auth", () => ({
  // `modules.nutrients: true` so the `/insights/nutrients` page tests below
  // reach their query instead of short-circuiting on the module-off branch;
  // no other surface in this file reads `user.modules`.
  useAuth: () => ({
    user: { gender: "FEMALE", modules: { nutrients: true } },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { MentalWellbeing } from "@/components/mental-health/mental-wellbeing";
import { MicronutrientsCard } from "@/components/insights/nutrients/micronutrients-card";
import InsightsNutrientsPage from "@/app/insights/nutrients/page";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // An errored query would otherwise refetch on mount, and the observer
        // reports that intent as an optimistic pending state during the server
        // render — which would hide the very branch under test.
        retryOnMount: false,
        staleTime: Infinity,
      },
    },
  });
}

/**
 * Drive `queryKey` to a settled failure through the public prefetch path, so
 * the SSR render below observes exactly the state a real failed read leaves in
 * the cache.
 */
async function seedFailure(
  client: QueryClient,
  queryKey: readonly unknown[],
): Promise<void> {
  await client.prefetchQuery({
    queryKey: queryKey as unknown[],
    queryFn: () => Promise.reject(new Error("read failed")),
    retry: false,
  });
}

function render(node: React.ReactNode, client: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

/** React's SSR serialiser escapes `'` as `&#x27;` in text nodes. */
function htmlEscaped(text: string): string {
  return text.replace(/'/g, "&#x27;");
}

describe("mental wellbeing — screening history", () => {
  const mh = en.mentalHealth;

  it("renders the error state with a retry when the history read fails", async () => {
    const client = makeClient();
    await seedFailure(client, queryKeys.mentalHealthAssessments());
    const html = render(<MentalWellbeing />, client);

    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain(mh.historyLoadError);
    expect(html).toContain(en.common.retry);
    // The load-bearing assertion: the instrument cards' "not taken yet" copy
    // must NOT appear. That sentence is a claim about the user's record.
    expect(html).not.toContain(mh.noResultYet);
  });

  it("still renders the instrument cards when the record is genuinely empty", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.mentalHealthAssessments(), {
      assessments: [],
    });
    const html = render(<MentalWellbeing />, client);

    expect(html).not.toContain('data-slot="query-error-card"');
    // An honest empty record: the cards render and invite a first check-in.
    expect(html).toContain(mh.noResultYet);
  });

  it("shows neither the empty copy nor an error while the read is in flight", () => {
    const html = render(<MentalWellbeing />, makeClient());
    expect(html).not.toContain('data-slot="query-error-card"');
    expect(html).not.toContain(mh.noResultYet);
  });
});

describe("micronutrients card", () => {
  const mn = en.nutrients.micronutrients;

  it("renders the error state with a retry when the nutrient read fails", async () => {
    const client = makeClient();
    await seedFailure(client, queryKeys.nutrientIntake(30));
    const html = render(<MicronutrientsCard />, client);

    // Inside its own card the failure is an inset row, never a card in a card.
    expect(html).toContain('data-slot="nutrients-micronutrients-error"');
    expect(html).not.toContain('data-slot="query-error-card"');
    expect(html).toContain(mn.loadError);
    expect(html).toContain(en.common.retry);
    expect(html).not.toContain(mn.emptyTitle);
  });

  it("still renders the empty state when the record is genuinely empty", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.nutrientIntake(30), { nutrients: [] });
    const html = render(<MicronutrientsCard />, client);

    expect(html).not.toContain('data-slot="nutrients-micronutrients-error"');
    expect(html).toContain(mn.emptyTitle);
  });
});

describe("/insights/nutrients page — overview read shares the micronutrients queryKey", () => {
  const np = en.nutrients.page;

  // The page's overview query and `<MicronutrientsCard>` read the exact same
  // `queryKeys.nutrientIntake(30)` cache entry. Before this branch existed, a
  // failed read left `overview.data` undefined — indistinguishable from the
  // pre-response state — so the page's empty-state check fired first and
  // returned "no nutrient data yet" without ever mounting the three cards
  // below (including `<MicronutrientsCard>`'s own, already-correct error
  // card).
  it("renders the page-level error card, not the empty state, when the overview read fails", async () => {
    const client = makeClient();
    await seedFailure(client, queryKeys.nutrientIntake(30));
    const html = render(<InsightsNutrientsPage />, client);

    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain(np.loadError);
    expect(html).toContain(en.common.retry);
    expect(html).not.toContain(np.emptyTitle);
    // The three-card spine must not mount alongside the error notice.
    expect(html).not.toContain('data-slot="nutrients-hydration-card"');
    expect(html).not.toContain('data-slot="nutrients-micronutrients-card"');
  });

  it("still renders the honest empty state when the window genuinely has no rows", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.nutrientIntake(30), {
      nutrients: [],
      lastAttempt: null,
    });
    const html = render(<InsightsNutrientsPage />, client);

    expect(html).not.toContain('data-slot="query-error-card"');
    expect(html).toContain(np.emptyTitle);
    expect(html).not.toContain(np.lastAttemptTitle);
  });

  // `GET /api/nutrients` returns `lastAttempt` non-null only when the window
  // is empty AND the most recent `nutrient.batch.ingest` audit row shows a
  // call that landed nothing — a batch CAN arrive and have every entry
  // rejected, which used to read on this page exactly like nothing ever
  // synced. The reason must render as the mapped human sentence, never the
  // raw wire code.
  it("names the sync attempt and its reason instead of the generic empty state", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.nutrientIntake(30), {
      nutrients: [],
      lastAttempt: {
        at: "2026-07-15T09:30:00.000Z",
        topReason: "unit_mismatch",
      },
    });
    const html = render(<InsightsNutrientsPage />, client);

    expect(html).toContain(np.lastAttemptTitle);
    expect(html).toContain(htmlEscaped(np.lastAttemptReason.unitMismatch));
    // The date line renders around a formatted timestamp; assert the fixed
    // prefix rather than the locale-formatted date itself.
    expect(html).toContain(np.lastAttemptAt.split("{date}")[0]);
    expect(html).not.toContain(np.emptyTitle);
    expect(html).not.toContain("unit_mismatch");
  });

  it("falls back to the generic reason sentence for an unmapped code", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.nutrientIntake(30), {
      nutrients: [],
      lastAttempt: {
        at: "2026-07-15T09:30:00.000Z",
        topReason: "some_future_reason",
      },
    });
    const html = render(<InsightsNutrientsPage />, client);

    expect(html).toContain(np.lastAttemptTitle);
    expect(html).toContain(htmlEscaped(np.lastAttemptReason.unknown));
  });
});

/**
 * The remaining surfaces in the sweep are pages whose render depends on the
 * router / module gate, which the SSR-only convention cannot drive. Pin their
 * contract structurally instead: each must read `isError` from its query and
 * hand a retry to the shared error card, so a later edit cannot quietly drop
 * the branch and fall back through to the empty state.
 */
describe("read-failure branch is wired on every swept surface", () => {
  const surfaces = [
    "src/components/mental-health/mental-wellbeing.tsx",
    "src/app/insights/workouts/page-client.tsx",
    "src/app/medications/[id]/page.tsx",
    "src/components/custom-metrics/custom-metric-values-list.tsx",
    "src/app/achievements/page.tsx",
    "src/components/insights/nutrients/micronutrients-card.tsx",
    // The page shares `MicronutrientsCard`'s exact queryKey and used to
    // short-circuit to the "no nutrient data yet" EmptyState on a failed
    // read, before that card's own (already-correct) error branch ever
    // got a chance to mount.
    "src/app/insights/nutrients/page.tsx",
    // A failed comprehensive read used to fall through to "you haven't added
    // any medications yet" — with a CTA inviting someone on a full daily
    // regimen to re-enter what the app already holds.
    "src/app/insights/medications/page.tsx",
    // The three sleep-rhythm cards share one read, so the PAGE owns the single
    // error notice rather than each card painting its own copy of it.
    "src/app/insights/sleep/page.tsx",
  ] as const;

  for (const rel of surfaces) {
    it(`${rel} reads isError and offers a retry`, () => {
      const source = readFileSync(join(process.cwd(), rel), "utf8");
      expect(source).toMatch(/isError/);
      expect(source).toMatch(/onRetry=/);
      expect(source).toMatch(/refetch/);
    });
  }
});

describe("the shared sleep-rhythm read has exactly one error notice", () => {
  it("no rhythm card renders the load-error string itself", () => {
    // One failed read used to paint the same sentence three times on
    // /insights/sleep, none of them offering a retry.
    for (const rel of [
      "src/components/insights/sleep/chronotype-section.tsx",
      "src/components/insights/sleep/average-sleep-section.tsx",
      "src/components/insights/sleep/sleep-rhythm-section.tsx",
    ]) {
      const source = readFileSync(join(process.cwd(), rel), "utf8");
      expect(source).not.toContain("rhythm.loadError");
    }
    const page = readFileSync(
      join(process.cwd(), "src/app/insights/sleep/page.tsx"),
      "utf8",
    );
    expect(page).toContain("rhythm.loadError");
    expect(page).toContain("QueryErrorCard");
  });
});

/**
 * The /insights/sleep page renders the shared rhythm error itself, so the
 * behaviour is observable — a structural check would still pass if the gate
 * were short-circuited, which the mutation check proved.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/insights/sleep",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-insights-analytics", () => ({
  useInsightsAnalytics: () => ({ isEmpty: false }),
}));

// The shared rhythm read is mocked at the hook rather than seeded in the cache:
// the hook sets its own staleTime, which makes a cache-seeded failure look like
// a pending refetch during a server render and hides the branch under test.
vi.mock("@/components/insights/sleep/use-sleep-rhythm", () => ({
  useSleepRhythm: () => ({
    data: undefined,
    isLoading: false,
    isError: true,
    refetch: () => {},
  }),
}));

const { default: SleepPage } = await import("@/app/insights/sleep/page");

describe("/insights/sleep — shared rhythm read", () => {
  it("renders exactly one error notice with a retry when the read fails", () => {
    const html = render(<SleepPage />, makeClient());

    // React escapes the apostrophe in the copy, so count the rendered cards
    // rather than the raw bundle string.
    const notices = html.split('data-slot="query-error-card"').length - 1;
    expect(notices).toBe(1);
    expect(html).toContain(en.common.retry);
    // The three sibling cards must not render alongside the notice.
    expect(html).not.toContain('data-slot="chronotype-error"');
  });
});
