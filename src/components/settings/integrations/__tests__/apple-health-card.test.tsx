import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
  health?: ConnectionHealth | null;
  metricFreshness?: Array<{
    type: string;
    lastSeenAt: string;
    stale: boolean;
    lastReceivedAt?: string | null;
    lastTrigger?: "foreground" | "background" | "push" | "manual" | null;
    lastNewSampleAt?: string | null;
    lastBackgroundAt?: string | null;
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

import type { ConnectionHealth } from "@/lib/integrations/connection-health";

import { AppleHealthCard, ArrivalDetail } from "../apple-health-card";
import { healthFixture } from "./health-fixture";

function render(locale: Locale = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <AppleHealthCard enabled />
    </I18nProvider>,
  );
}

// "Last data: today" only holds when the fixture's hours-ago stays on the same
// local day, so the clock is pinned to midday rather than the wall clock.
const PINNED_NOW = new Date("2026-10-08T12:00:00.000Z");
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

// The status read every case starts from, at file level so it runs before
// every case in every block: a block without it inherited a loading or error
// state from whichever case a shuffled run put before it.
beforeEach(() => {
  statusPayload = undefined;
  statusLoading = false;
  statusError = false;
});

describe("<AppleHealthCard>", () => {
  it("explains that live sync uses the iOS app rather than OAuth", () => {
    statusPayload = { lastSyncedAt: null, health: null };

    const html = render();

    expect(html).toContain('data-testid="apple-health-card"');
    expect(html).toContain('data-state="not_connected"');
    expect(html).toContain("HealthLog iOS app");
    expect(html).toContain("not from a web or OAuth connection");
    expect(html).toContain("Settings &gt; Apple Health");
    expect(html).toContain("when iOS grants background time");
    expect(html).toContain("Not connected.");
    expect(html).not.toContain('data-slot="integration-health-badge"');
  });

  it("says when data stopped and what to do, from the server's health", () => {
    const eightDaysAgo = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    statusPayload = {
      lastSyncedAt: eightDaysAgo,
      health: healthFixture({
        state: "degraded",
        reason: "no_new_data",
        since: eightDaysAgo,
        lastDataAt: eightDaysAgo,
      }),
    };

    const html = render();

    expect(html).toMatch(
      /data-slot="integration-health-badge"[^>]*data-state="degraded"/,
    );
    expect(html).toContain("Delayed");
    // Apple Health's own variant: the iPhone app is what moves the data.
    expect(html).toContain("Open HealthLog on your iPhone once.");
  });

  it("reads a recent delivery as working", () => {
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    statusPayload = {
      lastSyncedAt: anHourAgo,
      health: healthFixture({ lastDataAt: anHourAgo }),
    };

    const html = render();

    expect(html).toContain('data-state="ok"');
    expect(html).toContain("Data is arriving.");
    expect(html).toContain("Last data: today,");
  });

  it("keeps per-metric freshness in the details so one dead permission stays findable", () => {
    statusPayload = {
      lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      health: healthFixture(),
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
    const details = html.slice(html.indexOf('data-slot="integration-details"'));

    expect(details).toContain('data-slot="metric-freshness"');
    expect(details).toContain("1 quiet");
  });

  it("links to the existing one-shot Apple Health import fallback", () => {
    statusPayload = { lastSyncedAt: null, health: null };

    const html = render();

    expect(html).toContain('data-testid="apple-health-import-link"');
    expect(html).toContain(
      'href="/settings/export#settings-section-import-title"',
    );
    expect(html).toContain("Open one-shot import");
  });

  it("paints the card and its header while the read is in flight, and no state", () => {
    statusPayload = undefined;
    statusLoading = true;

    const html = render();

    expect(html).toContain('data-state="loading"');
    expect(html).not.toContain('data-slot="integration-health-badge"');
    expect(html).not.toContain("Not connected.");
  });

  it("treats a failed status read as an error line, not a status", () => {
    statusError = true;

    const html = render();

    expect(html).toContain("Apple Health status unavailable");
    expect(html).not.toContain('data-slot="integration-health-badge"');
    expect(html).not.toContain("Not connected.");
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
    ] as const;

    for (const catalog of [en, de, es, fr, itMessages, pl]) {
      const appleHealth = catalog.settings.appleHealth;
      for (const key of requiredKeys) {
        expect(appleHealth[key]).toBeTypeOf("string");
        expect(appleHealth[key].length).toBeGreaterThan(0);
      }
      expect(Object.keys(appleHealth.status).sort()).toEqual(["unavailable"]);
    }
  });

  it.each(["en", "de", "es", "fr", "it", "pl", "ko", "nl", "pt-BR"] as const)(
    "renders localized Apple Health copy for %s without leaking keys",
    (locale) => {
      statusPayload = { lastSyncedAt: null, health: null };

      const html = render(locale);

      expect(html).toContain("Apple Health");
      expect(html).not.toContain("settings.appleHealth.");
    },
  );
});

describe("<AppleHealthCard> — delivery diagnostic (#586)", () => {
  it("names how the last sync arrived and when data last came in on its own", () => {
    statusPayload = {
      lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastSyncTrigger: "background",
      lastBackgroundSyncAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      health: healthFixture(),
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
      health: healthFixture(),
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
      health: healthFixture(),
    };

    const html = render();

    expect(html).toContain(
      '<dd data-testid="apple-health-last-trigger">trigger not reported by the app</dd>',
    );
  });

  it("shows the setup steps instead of an empty delivery report before any sync", () => {
    statusPayload = {
      lastSyncedAt: null,
      health: null,
    };

    const html = render();

    expect(html).toContain("Turn on live sync");
    expect(html).not.toContain('data-testid="apple-health-delivery"');
    expect(html).not.toContain("Last background sync");
  });
});

// #778 — the first-run backfill used to be invisible: a user watching the web
// app had no way to tell "still flowing" from "looks dead but is working".
describe("<AppleHealthCard> — sync progress (#778)", () => {
  it("shows the accepted-row count and the oldest reading reached", () => {
    statusPayload = {
      lastSyncedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      health: healthFixture(),
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
      health: healthFixture(),
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
      health: healthFixture(),
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
      health: null,
      syncProgress: { recordsAccepted: 0, oldestMeasuredAt: null },
    };

    const html = render();

    // The delivery section's "no sync yet" line already owns the blank state.
    expect(html).not.toContain('data-testid="apple-health-progress"');
  });

  it("renders no progress section when the server read failed", () => {
    statusPayload = {
      lastSyncedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      health: healthFixture(),
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

  // #1259 — a duplicates-only batch no longer moves the arrival; the card
  // says the phone kept sending the type without hiding when it last brought
  // something.
  it("names a later re-send with nothing new beside the last arrival", () => {
    const out = html({
      ...base,
      lastReceivedAt: hoursAgo(20),
      lastTrigger: "foreground",
      lastNewSampleAt: hoursAgo(20),
      lastSeenDuplicateAt: hoursAgo(1),
    });
    expect(out).toContain("Last received 20 h ago");
    expect(out).toContain("Last re-sent with nothing new 1 h ago");
  });

  it("does not name a re-send older than the last arrival", () => {
    const out = html({
      ...base,
      lastReceivedAt: hoursAgo(1),
      lastTrigger: "foreground",
      lastNewSampleAt: hoursAgo(1),
      lastSeenDuplicateAt: hoursAgo(5),
    });
    expect(out).not.toContain("Last re-sent");
  });

  // v1.42.4 — opening the app to look starts a foreground sync; the earlier
  // background arrival must stay visible beside it.
  it("keeps the last background arrival visible after a later foreground one", () => {
    const out = html({
      ...base,
      lastReceivedAt: hoursAgo(1),
      lastTrigger: "foreground",
      lastNewSampleAt: hoursAgo(1),
      lastBackgroundAt: hoursAgo(5),
    });
    expect(out).toContain('data-trigger="foreground"');
    expect(out).toContain("Last in background 5 h ago");
  });

  it("does not repeat the background date when the last arrival was it", () => {
    const out = html({
      ...base,
      lastReceivedAt: hoursAgo(1),
      lastTrigger: "background",
      lastNewSampleAt: hoursAgo(1),
      lastBackgroundAt: hoursAgo(1),
    });
    expect(out).not.toContain("Last in background");
  });

  // v1.43 (ios #77) — a history catch-up is named apart, and a type that
  // only ever arrived through one still reads as not received live.
  it("names the last backfill apart from the live arrival", () => {
    const live = html({
      ...base,
      lastReceivedAt: hoursAgo(1),
      lastTrigger: "foreground",
      lastNewSampleAt: hoursAgo(1),
      lastBackfillAt: hoursAgo(3),
    });
    expect(live).toContain('data-state="received"');
    expect(live).toContain("History caught up 3 h ago");
    const backfillOnly = html({
      ...base,
      lastReceivedAt: null,
      lastTrigger: null,
      lastNewSampleAt: null,
      lastBackfillAt: hoursAgo(2),
    });
    expect(backfillOnly).toContain('data-state="never"');
    expect(backfillOnly).toContain(
      "Not received yet, History caught up 2 h ago",
    );
  });

  it("names the medication dose row in the freshness list", () => {
    statusPayload = {
      lastSyncedAt: hoursAgo(1),
      health: healthFixture(),
      metricFreshness: [
        {
          type: "MEDICATION_DOSE",
          lastSeenAt: hoursAgo(3),
          stale: false,
          lastReceivedAt: hoursAgo(1),
          lastTrigger: "foreground",
          lastNewSampleAt: hoursAgo(1),
          lastBackgroundAt: hoursAgo(6),
        },
      ],
    };
    const out = render();
    expect(out).toContain("Medication doses");
    expect(out).toContain("Last in background");
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

  // #1247 — weight entered here goes to the phone and never arrives back.
  it("names when a written-back type was last entered here", () => {
    const received = html({
      ...base,
      type: "WEIGHT",
      lastReceivedAt: hoursAgo(400),
      lastTrigger: "background",
      lastNewSampleAt: hoursAgo(400),
      lastEnteredHereAt: hoursAgo(48),
    });
    expect(received).toContain("Last entered here 2 d ago");
    const never = html({
      ...base,
      type: "WEIGHT",
      lastReceivedAt: null,
      lastEnteredHereAt: hoursAgo(48),
    });
    expect(never).toContain("Not received yet");
    expect(never).toContain("Last entered here 2 d ago");
    const noLedger = html({
      ...base,
      type: "WEIGHT",
      lastEnteredHereAt: hoursAgo(48),
    });
    expect(noLedger).toContain('data-state="entered-here"');
  });

  it("renders nothing when the server sent no arrival facts", () => {
    expect(html(base)).toBe("");
  });

  it("titles the list by data type", () => {
    statusPayload = {
      lastSyncedAt: hoursAgo(1),
      health: healthFixture(),
      metricFreshness: [{ ...base }],
    };
    expect(render()).toContain("By data type");
  });
});
