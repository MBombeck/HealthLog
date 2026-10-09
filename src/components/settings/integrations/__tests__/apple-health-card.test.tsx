import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Locale } from "@/lib/i18n/config";
import { I18nProvider } from "@/lib/i18n/context";
import de from "../../../../../messages/de.json";
import en from "../../../../../messages/en.json";
import es from "../../../../../messages/es.json";
import fr from "../../../../../messages/fr.json";
import itMessages from "../../../../../messages/it.json";
import pl from "../../../../../messages/pl.json";

type Payload = {
  lastSyncedAt: string | null;
  lastSyncTrigger?: "foreground" | "background" | "push" | null;
  lastBackgroundSyncAt?: string | null;
  syncHealth?: { verdict: string; since: string | null };
  metricFreshness?: Array<{
    type: string;
    lastSeenAt: string;
    stale: boolean;
  }>;
  syncProgress?: {
    recordsAccepted: number;
    oldestMeasuredAt: string | null;
  } | null;
};

let statusPayload: Payload | undefined;
let statusLoading = false;
let statusError = false;

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: statusPayload,
    isLoading: statusLoading,
    isError: statusError,
  }),
}));

import { AppleHealthCard, ArrivalDetail } from "../apple-health-card";

function render(locale: Locale = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <AppleHealthCard enabled />
    </I18nProvider>,
  );
}

describe("<AppleHealthCard>", () => {
  beforeEach(() => {
    statusPayload = undefined;
    statusLoading = false;
    statusError = false;
  });

  it("explains that live sync uses the iOS app rather than OAuth", () => {
    statusPayload = {
      lastSyncedAt: null,
      syncHealth: { verdict: "pending_first_sync", since: null },
    };

    const html = render();

    expect(html).toContain('data-testid="apple-health-card"');
    expect(html).toContain("HealthLog iOS app");
    expect(html).toContain("not from a web or OAuth connection");
    expect(html).toContain("Settings → Apple Health");
    expect(html).toContain("when iOS grants background time");
    expect(html).not.toContain(">Connected<");
  });

  /**
   * The defect this card carried: any `lastSyncedAt` at all painted the green
   * "data received" chip, so a pipe dead for three weeks looked exactly like
   * one that delivered this morning. The verdict now decides.
   */
  it("shows a week-old delivery as stale, not as data received", () => {
    const eightDaysAgo = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    statusPayload = {
      lastSyncedAt: eightDaysAgo,
      syncHealth: { verdict: "stale", since: eightDaysAgo },
    };

    const html = render();

    expect(html).toContain('data-testid="apple-health-status"');
    expect(html).toContain('data-state="stale"');
    expect(html).toContain("no recent data");
    // And it says what to do about it.
    expect(html).toContain('data-testid="apple-health-stale"');
    expect(html).not.toContain('data-state="connected"');
  });

  it("shows a recent delivery as connected with its relative time", () => {
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    statusPayload = {
      lastSyncedAt: anHourAgo,
      syncHealth: { verdict: "fresh", since: null },
    };

    const html = render();

    expect(html).toContain('data-state="connected"');
    expect(html).toMatch(/1\s+h\s+ago/);
    expect(html).not.toContain('data-testid="apple-health-stale"');
  });

  it("waits for the first delivery rather than claiming a connection", () => {
    statusPayload = {
      lastSyncedAt: null,
      syncHealth: { verdict: "pending_first_sync", since: null },
    };

    const html = render();

    expect(html).toContain('data-state="pending-setup"');
    expect(html).toContain("Waiting for first data");
    expect(html).not.toContain('data-state="connected"');
  });

  it("renders per-metric freshness so one dead permission is visible", () => {
    statusPayload = {
      lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      syncHealth: { verdict: "fresh", since: null },
      metricFreshness: [
        {
          type: "RESPIRATORY_RATE",
          lastSeenAt: new Date(
            Date.now() - 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          stale: true,
        },
        {
          type: "PULSE",
          lastSeenAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          stale: false,
        },
      ],
    };

    const html = render();

    expect(html).toContain('data-slot="metric-freshness"');
    // The collapsed summary already names the problem — the signal must not
    // hide behind a click.
    expect(html).toContain("quiet");
  });

  it("carries no card divider — the card gap does that job", () => {
    statusPayload = {
      lastSyncedAt: null,
      syncHealth: { verdict: "pending_first_sync", since: null },
    };
    expect(render()).not.toContain('data-testid="integration-card-divider"');
  });

  it("links to the existing one-shot Apple Health import fallback", () => {
    statusPayload = {
      lastSyncedAt: null,
      syncHealth: { verdict: "pending_first_sync", since: null },
    };

    const html = render();

    expect(html).toContain('data-testid="apple-health-import-link"');
    expect(html).toContain(
      'href="/settings/export#settings-section-import-title"',
    );
    expect(html).toContain("Open one-shot import");
  });

  it("claims no status at all while the read is in flight", () => {
    statusPayload = undefined;
    statusLoading = true;

    const html = render();

    expect(html).not.toContain('data-testid="apple-health-status"');
    expect(html).not.toContain("Connected");
  });

  it("treats a failed status read as an error line, not a status", () => {
    statusError = true;

    const html = render();

    expect(html).toContain("Apple Health status unavailable");
    expect(html).toContain('data-testid="integration-error-message"');
    expect(html).not.toContain('data-testid="apple-health-status"');
    expect(html).not.toContain("Connected");
  });

  it("defines every card key in all six locale catalogs", () => {
    const requiredKeys = [
      "title",
      "description",
      "setupTitle",
      "permissionStep",
      "backgroundStep",
      "importNote",
      "importAction",
      "staleNote",
    ] as const;

    for (const catalog of [en, de, es, fr, itMessages, pl]) {
      const appleHealth = catalog.settings.appleHealth;
      for (const key of requiredKeys) {
        expect(appleHealth[key]).toBeTypeOf("string");
        expect(appleHealth[key].length).toBeGreaterThan(0);
      }
      // The status copy the pill now owns is gone from the catalog; only the
      // failed-read line survives here.
      expect(Object.keys(appleHealth.status).sort()).toEqual(["unavailable"]);
    }
  });

  it.each(["en", "de", "es", "fr", "it", "pl", "ko"] as const)(
    "renders localized Apple Health copy for %s without leaking keys",
    (locale) => {
      statusPayload = {
        lastSyncedAt: null,
        syncHealth: { verdict: "pending_first_sync", since: null },
      };

      const html = render(locale);

      expect(html).toContain("Apple Health");
      expect(html).not.toContain("settings.appleHealth.");
    },
  );
});

describe("<AppleHealthCard> — delivery diagnostic (#586)", () => {
  beforeEach(() => {
    statusPayload = undefined;
    statusLoading = false;
    statusError = false;
  });

  it("names how the last sync arrived and when data last came in on its own", () => {
    statusPayload = {
      lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastSyncTrigger: "background",
      lastBackgroundSyncAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      syncHealth: { verdict: "fresh", since: null },
    };

    const html = render();

    expect(html).toContain('data-testid="apple-health-delivery"');
    expect(html).toContain("in the background");
    expect(html).toContain("Last background sync");
  });

  it("says plainly that background delivery has never happened", () => {
    statusPayload = {
      lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastSyncTrigger: "foreground",
      lastBackgroundSyncAt: null,
      syncHealth: { verdict: "fresh", since: null },
    };

    const html = render();

    // The reporter's question, answered rather than left to inference: every
    // sync so far arrived while the app was open.
    expect(html).toContain("with the app open");
    expect(html).toContain("every sync so far arrived with the app open");
  });

  it("reports a missing trigger as unreported instead of guessing one", () => {
    statusPayload = {
      lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastSyncTrigger: null,
      lastBackgroundSyncAt: null,
      syncHealth: { verdict: "fresh", since: null },
    };

    const html = render();

    expect(html).toContain(
      '<dd data-testid="apple-health-last-trigger">trigger not reported by the app</dd>',
    );
  });

  it("says there is nothing to report when no sync has ever arrived", () => {
    statusPayload = {
      lastSyncedAt: null,
      syncHealth: { verdict: "pending_first_sync", since: null },
    };

    const html = render();

    expect(html).toContain("No sync has arrived yet");
    expect(html).not.toContain("Last background sync");
  });
});

// #778 — the first-run backfill used to be invisible: a user watching the web
// app had no way to tell "still flowing" from "looks dead but is working".
describe("<AppleHealthCard> — sync progress (#778)", () => {
  beforeEach(() => {
    statusPayload = undefined;
    statusLoading = false;
    statusError = false;
  });

  it("shows the accepted-row count and the oldest reading reached", () => {
    statusPayload = {
      lastSyncedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      syncHealth: { verdict: "fresh", since: null },
      syncProgress: {
        recordsAccepted: 12345,
        oldestMeasuredAt: "2019-05-04T06:00:00.000Z",
      },
    };

    const html = render();

    expect(html).toContain('data-testid="apple-health-progress"');
    expect(html).toContain('data-testid="apple-health-progress-received"');
    // Locale-grouped integer, so the count reads as a number, not a code.
    expect(html).toContain("12,345");
    expect(html).toContain('data-testid="apple-health-progress-oldest"');
    // The 2019 date renders with its year — the whole point is showing how
    // far back the backfill has reached.
    expect(html).toContain("2019");
  });

  it("reads as flowing while batches keep arriving", () => {
    statusPayload = {
      lastSyncedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      syncHealth: { verdict: "fresh", since: null },
      syncProgress: { recordsAccepted: 100, oldestMeasuredAt: null },
    };

    const html = render();

    expect(html).toContain('data-testid="apple-health-progress-state"');
    expect(html).toContain('data-state="flowing"');
    expect(html).toContain("still delivering");
  });

  it("waits honestly instead of inventing throttle state when batches pause", () => {
    statusPayload = {
      lastSyncedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      syncHealth: { verdict: "fresh", since: null },
      syncProgress: { recordsAccepted: 100, oldestMeasuredAt: null },
    };

    const html = render();

    expect(html).toContain('data-state="waiting"');
    // The server does not track the phone's throttle/queue state, so the copy
    // says "waiting for the iPhone app", never a fabricated percentage or ETA.
    expect(html).toContain("Waiting for the iPhone app to send more data");
    expect(html).not.toContain("%");
  });

  it("renders no progress section before anything has arrived", () => {
    statusPayload = {
      lastSyncedAt: null,
      syncHealth: { verdict: "pending_first_sync", since: null },
      syncProgress: { recordsAccepted: 0, oldestMeasuredAt: null },
    };

    const html = render();

    // The delivery section's "no sync yet" line already owns the blank state.
    expect(html).not.toContain('data-testid="apple-health-progress"');
  });

  it("renders no progress section when the server read failed", () => {
    statusPayload = {
      lastSyncedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      syncHealth: { verdict: "fresh", since: null },
      syncProgress: null,
    };

    const html = render();

    expect(html).not.toContain('data-testid="apple-health-progress"');
  });

  it("defines every progress key in all six locale catalogs", () => {
    const requiredKeys = [
      "title",
      "receivedLabel",
      "oldestLabel",
      "flowing",
      "waiting",
    ] as const;

    for (const catalog of [en, de, es, fr, itMessages, pl]) {
      const progress = catalog.settings.appleHealth.progress;
      for (const key of requiredKeys) {
        expect(progress[key]).toBeTypeOf("string");
        expect(progress[key].length).toBeGreaterThan(0);
      }
    }
  });
});

describe("<AppleHealthCard> — per-type arrivals (#1173)", () => {
  const now = new Date("2026-10-08T12:00:00.000Z");
  const hoursAgo = (h: number) =>
    new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
  const base = {
    type: "RESPIRATORY_RATE",
    lastSeenAt: hoursAgo(5),
    stale: false,
  };
  const t = (key: string, params?: Record<string, string | number>) => {
    const value = key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown>)?.[part],
        en,
      );
    if (typeof value !== "string") return key;
    return value.replace(/\{(\w+)\}/g, (_, name: string) =>
      String(params?.[name] ?? `{${name}}`),
    );
  };
  const html = (entry: Parameters<typeof ArrivalDetail>[0]["entry"]) =>
    renderToStaticMarkup(<ArrivalDetail entry={entry} t={t} now={now} />);

  it("names when a type last arrived and that only Sync all carried it", () => {
    const out = html({
      ...base,
      lastReceivedAt: hoursAgo(2),
      lastTrigger: "manual",
      lastNewSampleAt: hoursAgo(2),
    });
    expect(out).toContain('data-trigger="manual"');
    expect(out).toContain("Last received 2 h ago");
    expect(out).toContain("from Sync all");
    // The last arrival brought something new, so no second date is needed.
    expect(out).not.toContain("Last new value");
  });

  it("adds the last new value when the latest arrival held duplicates only", () => {
    const out = html({
      ...base,
      lastReceivedAt: hoursAgo(1),
      lastTrigger: "background",
      lastNewSampleAt: hoursAgo(72),
    });
    expect(out).toContain("in the background");
    expect(out).toContain("Last new value 3 d ago");
  });

  it("says a type has not arrived through live sync yet", () => {
    const out = html({
      ...base,
      lastReceivedAt: null,
      lastTrigger: null,
      lastNewSampleAt: null,
    });
    expect(out).toContain('data-state="never"');
    expect(out).toContain("Not received yet");
  });

  it("renders nothing when the server sent no arrival facts", () => {
    expect(html(base)).toBe("");
  });

  it("titles the list by data type", () => {
    statusPayload = {
      lastSyncedAt: hoursAgo(1),
      syncHealth: { verdict: "fresh", since: null },
      metricFreshness: [{ ...base }],
    };
    expect(render()).toContain("By data type");
  });
});
