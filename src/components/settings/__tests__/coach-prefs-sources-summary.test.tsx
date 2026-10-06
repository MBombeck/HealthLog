/**
 * Settings → Coach says what the Coach reads at the saved setting, in one
 * sentence, beside the link into the Coach's own settings: how many data
 * areas are on, out of how many, and how far back it looks.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({
    available: true,
    reason: null,
    onDeviceAllowed: false,
  }),
  // v1.41 — the thinking depth reads the resolved block; none here.
  useCoachReasoning: () => null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/coach",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  DEFAULT_COACH_CLUSTERS,
  DEFAULT_COACH_PREFS,
  coachDataClusterEnum,
  type CoachPrefs,
} from "@/lib/validations/coach-prefs";
import { CoachPrefsSection } from "../coach-prefs-section";

function summary(prefs: CoachPrefs): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.coachPrefs(), prefs);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <CoachPrefsSection isAuthenticated />
      </I18nProvider>
    </QueryClientProvider>,
  );
  const match = html.match(
    /data-slot="coach-prefs-sources-summary"[^>]*>([^<]*)</,
  );
  expect(match, "summary rendered").not.toBeNull();
  return match![1];
}

const TOTAL = coachDataClusterEnum.options.length;

describe("Settings → Coach sources summary", () => {
  it("counts the default areas and says the whole history is read", () => {
    expect(summary(DEFAULT_COACH_PREFS)).toBe(
      `The Coach sees ${DEFAULT_COACH_CLUSTERS.length} of ${TOTAL} data areas and your whole history.`,
    );
  });

  it("names a bounded lookback in the picker's words", () => {
    expect(
      summary({
        ...DEFAULT_COACH_PREFS,
        dataClusters: ["cardio", "sleep"],
        defaultWindow: "last90days",
      }),
    ).toBe(`The Coach sees 2 of ${TOTAL} data areas and looks back 90 days.`);
    expect(
      summary({
        ...DEFAULT_COACH_PREFS,
        dataClusters: [],
        defaultWindow: "lastYear",
      }),
    ).toBe(`The Coach sees 0 of ${TOTAL} data areas and looks back 12 months.`);
  });
});
