/**
 * v1.42 (#613) — the whole timeline page, at every zoom and every bucket,
 * shows no message key. Rendered through SSR with the reads stubbed, in two
 * languages: the zoom control, the legend, the selection bar's head and its
 * "no value" means, the lanes table and the phone chronicle all come out of
 * one render, so a key that only one zoom or one bucket reaches is reached
 * here too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  TIMELINE_BUCKETS,
  TIMELINE_ZOOMS,
  type TimelineBucket,
  type TimelineResponse,
  type TimelineZoom,
} from "@/lib/day/contract";
import { I18nProvider } from "@/lib/i18n/context";

import { TODAY, fullTimeline, readiness } from "./timeline-fixture";

let search = new URLSearchParams();
let timeline: TimelineResponse = fullTimeline();

vi.mock("next/navigation", () => ({
  usePathname: () => "/timeline",
  useSearchParams: () => search,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", timezone: "Europe/Berlin", modules: {} },
  }),
}));
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ inSharedRecord: false }),
}));
vi.mock("../use-timeline", () => ({
  useTimeline: () => ({
    data: timeline,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useTimelineReadiness: () => ({
    data: readiness(),
    isPending: false,
    isError: false,
  }),
  useLifeEvents: () => ({ data: { events: [] } }),
  useLifeEventMutations: () => ({
    create: { isPending: false },
    update: { isPending: false },
    remove: { isPending: false },
  }),
}));
vi.mock("../timeline-dates", async (importOriginal) => {
  const real = await importOriginal<typeof import("../timeline-dates")>();
  return { ...real, todayKeyIn: () => TODAY };
});

/** The text a reader sees: every character outside a tag, runs kept apart. */
function textOf(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">") {
      inTag = false;
      out += " ";
    } else if (!inTag) out += ch;
  }
  return out;
}

/** A message key as it would leak: a namespace, a dot, a name. */
const RAW_KEY =
  /\b(?:timeline|day|lifeEvents|documents|encounters|mentalHealth|insights|records|cycle|illness|charts|measurements)\.[a-zA-Z][\w.]*/g;

async function renderView(
  zoom: TimelineZoom,
  bucket: TimelineBucket,
  locale: "de" | "en",
) {
  search = new URLSearchParams({ zoom });
  if (zoom === "range") {
    search.set("from", "2025-10-01");
    search.set("to", "2026-01-31");
  }
  timeline = { ...fullTimeline(), zoom, bucket };
  const { TimelineView } = await import("../timeline-view");
  return textOf(
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider initialLocale={locale}>
          <TimelineView />
        </I18nProvider>
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  search = new URLSearchParams();
});

describe("the timeline page shows no message key", () => {
  for (const locale of ["de", "en"] as const) {
    for (const zoom of TIMELINE_ZOOMS) {
      for (const bucket of TIMELINE_BUCKETS) {
        it(`${locale}, zoom ${zoom}, bucket ${bucket}`, async () => {
          const text = await renderView(zoom, bucket, locale);
          // The render reached the page, not a loading or error state.
          expect(text.length).toBeGreaterThan(500);
          expect([...new Set(text.match(RAW_KEY) ?? [])]).toEqual([]);
        });
      }
    }
  }
});
