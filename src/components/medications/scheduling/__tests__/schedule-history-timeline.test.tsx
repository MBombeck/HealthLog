/**
 * v1.16.5 — schedule-history timeline SSR smoke tests.
 *
 * Project convention: `renderToStaticMarkup` + assertions against the
 * SSR string, react-query data seeded via `setQueryData` so `useQuery`
 * resolves synchronously (no `@testing-library/react` installed).
 * Interactive branches (toggle click, dialog submit, delete confirm)
 * are covered by the route tests + the `defaultExpanded` render path
 * here; the contracts pinned:
 *
 *   1. Live plan row: deduped/sorted times + "current since" line.
 *   2. Collapsed default: era rows absent, toggle carries the count.
 *   3. Expanded: each era renders times + date range; MANUAL eras get
 *      the chip + delete affordance, ARCHIVED eras get neither.
 *   4. No revisions: no toggle, the add-era CTA still renders.
 *   5. `eraTimes` dedupes/sorts across entries and drops non-arrays.
 *   6. v1.16.6: every era row (MANUAL and ARCHIVED) carries the edit
 *      pencil; only MANUAL rows carry delete.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import {
  ScheduleHistoryTimeline,
  eraTimes,
  type ScheduleRevisionRow,
} from "@/components/medications/scheduling/schedule-history-timeline";
import { queryKeys } from "@/lib/query-keys";

const MED_ID = "med-1";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
      },
    },
  });
}

function seed(
  client: QueryClient,
  data: { currentSince: string; revisions: ScheduleRevisionRow[] },
) {
  client.setQueryData(queryKeys.medicationScheduleRevisions(MED_ID), data);
}

function render(
  client: QueryClient,
  props?: Partial<Parameters<typeof ScheduleHistoryTimeline>[0]>,
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="de">
      <QueryClientProvider client={client}>
        <ScheduleHistoryTimeline
          medicationId={MED_ID}
          currentTimes={["20:00", "08:00", "08:00"]}
          {...props}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function actionMarkup(html: string, slot: string): string[] {
  return (
    html.match(
      new RegExp(
        `<button(?=[^>]*data-slot="${slot}")[^>]*>[\\s\\S]*?</button>`,
        "g",
      ),
    ) ?? []
  );
}

const MANUAL_ERA: ScheduleRevisionRow = {
  id: "rev-manual",
  validFrom: "2026-03-12T00:00:00.000Z",
  validUntil: "2026-06-01T00:00:00.000Z",
  source: "MANUAL",
  entries: [
    {
      timesOfDay: ["07:00", "19:00"],
      label: null,
      dose: null,
      scheduleType: "SCHEDULED",
    },
  ],
};

const ARCHIVED_ERA: ScheduleRevisionRow = {
  id: "rev-archived",
  validFrom: "2026-01-10T00:00:00.000Z",
  validUntil: "2026-03-12T00:00:00.000Z",
  source: "ARCHIVED",
  entries: [
    {
      timesOfDay: ["09:00"],
      label: "Morgens",
      dose: null,
      scheduleType: "SCHEDULED",
    },
  ],
};

describe("ScheduleHistoryTimeline", () => {
  it("renders the live plan with deduped, sorted times and the since line", () => {
    const client = makeClient();
    seed(client, { currentSince: "2026-06-01T00:00:00.000Z", revisions: [] });
    const html = render(client);
    expect(html).toContain("08:00 / 20:00");
    expect(html).toContain("Aktueller Plan seit");
    expect(html).toContain("01.06.2026");
  });

  it("collapses predecessor eras by default and counts them in the toggle", () => {
    const client = makeClient();
    seed(client, {
      currentSince: "2026-06-01T00:00:00.000Z",
      revisions: [MANUAL_ERA, ARCHIVED_ERA],
    });
    const html = render(client);
    expect(html).toContain("2 frühere Ären anzeigen");
    expect(html).not.toContain("07:00 / 19:00");
    expect(html).not.toContain("zeitplan-history-era");
  });

  it("expanded: era rows carry times, range, and MANUAL-only affordances", () => {
    const client = makeClient();
    seed(client, {
      currentSince: "2026-06-01T00:00:00.000Z",
      revisions: [MANUAL_ERA, ARCHIVED_ERA],
    });
    const html = render(client, { defaultExpanded: true });
    expect(html).toContain("07:00 / 19:00");
    expect(html).toContain("12.03.2026");
    expect(html).toContain("01.06.2026");
    expect(html).toContain("Manuell ergänzt");
    expect(html).toContain("Ära löschen");
    // Exactly ONE manual chip + ONE delete button — the archived era
    // renders without delete.
    expect(html.match(/zeitplan-history-manual-chip/g)).toHaveLength(1);
    expect(html.match(/zeitplan-history-delete/g)).toHaveLength(1);
    // BOTH eras carry the edit pencil: a MANUAL era edits in place, an
    // ARCHIVED era is corrected via a superseding revision.
    expect(html.match(/zeitplan-history-edit/g)).toHaveLength(2);
    expect(html).toContain("Ära bearbeiten");
    expect(html).toContain("Frühere Ären ausblenden");
  });

  it("uses non-overlapping 44px mobile era actions with compact icons", () => {
    const client = makeClient();
    seed(client, {
      currentSince: "2026-06-01T00:00:00.000Z",
      revisions: [MANUAL_ERA, ARCHIVED_ERA],
    });
    const html = render(client, { defaultExpanded: true });
    const editButtons = actionMarkup(html, "zeitplan-history-edit");
    const deleteButtons = actionMarkup(html, "zeitplan-history-delete");
    expect(editButtons).toHaveLength(2);
    expect(deleteButtons).toHaveLength(1);
    for (const button of [...editButtons, ...deleteButtons]) {
      expect(button).toContain("size-11");
      expect(button).toContain("sm:size-8");
      expect(button).toContain("size-4");
    }
    expect(editButtons[0]).toContain('aria-label="Ära bearbeiten"');
    expect(deleteButtons[0]).toContain('aria-label="Ära löschen"');
    expect(html).toContain('class="flex shrink-0 items-center"');
  });

  it("renders the add-era CTA without a toggle when no era exists", () => {
    const client = makeClient();
    seed(client, { currentSince: "2026-06-01T00:00:00.000Z", revisions: [] });
    const html = render(client);
    expect(html).toContain("Frühere Ära ergänzen");
    expect(html).not.toContain("zeitplan-history-toggle");
  });
});

describe("eraTimes", () => {
  it("dedupes and sorts across entries", () => {
    expect(
      eraTimes([
        {
          timesOfDay: ["19:00", "07:00"],
          label: null,
          dose: null,
          scheduleType: "SCHEDULED",
        },
        {
          timesOfDay: ["07:00", "12:00"],
          label: null,
          dose: null,
          scheduleType: "SCHEDULED",
        },
      ]),
    ).toEqual(["07:00", "12:00", "19:00"]);
  });

  it("tolerates a non-array timesOfDay", () => {
    expect(
      eraTimes([
        {
          timesOfDay: undefined as unknown as string[],
          label: null,
          dose: null,
          scheduleType: "PRN",
        },
      ]),
    ).toEqual([]);
  });
});
