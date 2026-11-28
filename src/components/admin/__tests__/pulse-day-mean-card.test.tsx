/**
 * The pulse day-mean admin card.
 *
 *   1. apply is offered only after a dry run finished in the last seven days,
 *      and never while a dry run is queued or running;
 *   2. a finished dry run shows its figures and the per-account ordinals;
 *   3. the active method reads in the header, in German too.
 *
 * Mutation check: drop `hasFreshDryRun` from `canApply` and case 1 goes red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PulseDayMeanCard } from "@/components/admin/pulse-day-mean-card";
import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { PulseDayMeanStatus } from "@/lib/validations/pulse-day-mean";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

const RESULT = {
  accounts: 2,
  daysCompared: 412,
  daysChangedOver1Bpm: 37,
  maxChangeBpm: 6.4,
  distribution: [
    { bucket: "0-1" as const, days: 375 },
    { bucket: "1-2" as const, days: 30 },
    { bucket: "2-5" as const, days: 6 },
    { bucket: "5+" as const, days: 1 },
  ],
  perAccount: [
    { account: "#1", days: 400, changedOver1Bpm: 36 },
    { account: "#2", days: 12, changedOver1Bpm: 1 },
  ],
};

const status = (
  lastDryRun: PulseDayMeanStatus["lastDryRun"],
  method: PulseDayMeanStatus["method"] = "hour_mean_v1",
): PulseDayMeanStatus => ({
  method,
  appliedAt: null,
  lastDryRun,
  lastRebuild: null,
});

const done = (finishedAt: string) => ({
  status: "done" as const,
  startedAt: finishedAt,
  finishedAt,
  result: RESULT,
});

function render(s: PulseDayMeanStatus, locale: "en" | "de" = "en"): string {
  const client = new QueryClient();
  client.setQueryData(queryKeys.adminPulseDayMean(), s);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>
        <PulseDayMeanCard />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** Whether the apply button renders disabled. */
function applyDisabled(html: string): boolean {
  const at = html.indexOf('data-testid="admin-pulse-day-mean-apply"');
  const tag = html.slice(
    html.lastIndexOf("<button", at),
    html.indexOf(">", at),
  );
  return /\sdisabled=""/.test(tag);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("PulseDayMeanCard", () => {
  it("offers apply only after a fresh, finished dry run", () => {
    expect(applyDisabled(render(status(null)))).toBe(true);
    expect(
      applyDisabled(render(status(done("2026-10-08T12:00:00.000Z")))),
    ).toBe(true);
    expect(
      applyDisabled(
        render(
          status({
            status: "running",
            startedAt: "2026-10-16T11:00:00.000Z",
            finishedAt: null,
            result: null,
          }),
        ),
      ),
    ).toBe(true);
    expect(
      applyDisabled(render(status(done("2026-10-15T12:00:00.000Z")))),
    ).toBe(false);
  });

  it("shows what the dry run found", () => {
    const html = render(status(done("2026-10-15T12:00:00.000Z")));
    expect(html).toContain("412");
    expect(html).toContain("37");
    expect(html).toContain("6.4\u00a0bpm");
    expect(html).toContain("5+\u00a0bpm");
    expect(html).toContain("Account #2");
    expect(html).toContain("36 of 400 days move");
  });

  it("names the active method, in German too", () => {
    expect(render(status(null))).toContain("Every hour equal");
    const de = render(status(null, "weighted_hour_mean_v2"), "de");
    expect(de).toContain("Dünne Stunden gewichtet");
    expect(de).toContain("Probelauf");
  });

  it("shows a stopped recalculation and offers it again without a dry run", () => {
    const failed: PulseDayMeanStatus = {
      ...status(done("2026-10-01T10:00:00Z"), "weighted_hour_mean_v2"),
      appliedAt: "2026-10-01T11:00:00Z",
      lastRebuild: {
        status: "failed",
        startedAt: "2026-10-01T11:00:00Z",
        finishedAt: "2026-10-01T11:05:00Z",
        accounts: null,
        rows: null,
      },
    };
    const html = render(failed);
    expect(html).toContain('data-state="failed"');
    expect(html).toContain('data-testid="admin-pulse-day-mean-rebuild"');

    const finished = render({
      ...failed,
      lastRebuild: {
        ...failed.lastRebuild!,
        status: "done",
        accounts: 3,
        rows: 900,
      },
    });
    expect(finished).not.toContain("admin-pulse-day-mean-rebuild");
    expect(finished).toContain('data-slot="pulse-day-mean-rebuild"');
  });
});
