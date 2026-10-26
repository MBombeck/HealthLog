/**
 * Parity for `GET / PUT / DELETE /api/dashboard/widgets` while the layout
 * logic moves out of the route into `src/lib/dashboard/widgets/`.
 *
 * One owner walks through the cases the route tells apart, in order, each
 * request seeing what the earlier ones stored: the first read (the default
 * layout, filled into the cache), the same read from the cache, a full save
 * that carries ids outside the catalogue, a partial save that leans on the
 * stored layout (including a per-chart range the client left out), the
 * refusals (schema, an empty body, junk and stale base tokens), a save on
 * the current token, reads with the recovery module off before and after an
 * HRV series exists, a delegate reading the owner's layout and being refused
 * the write and the reset, the owner's reset, and an anonymous call. After
 * each request the snapshot holds the response, the wide event and the
 * stored layout blob.
 *
 * The clock is pinned (`Date` only) and moved one second per step, so the
 * concurrency token advances between writes the way it does in production.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DELETE, GET, PUT } from "@/app/api/dashboard/widgets/route";
import { DEFAULT_DASHBOARD_LAYOUT } from "@/lib/dashboard-layout";

import {
  anonymous,
  callRoute,
  type HttpMethod,
  type RouteAuth,
} from "../../../kit/call-route";
import {
  makeGrant,
  makeMeasurement,
  makeSession,
  makeUser,
  type SessionFixture,
} from "../../../kit/factories";
import {
  eventFacts,
  expectParity,
  stable,
  wideEventRecorder,
} from "../../../kit/parity";
import { headerJar } from "../../mock-next-headers";
import {
  getPrismaClient,
  switchSessionTo,
  truncateAllTables,
} from "../../setup";

vi.mock("@/lib/logging/transports", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/logging/transports")>();
  const { wideEventRecorder: recorder } = await import("../../../kit/parity");
  return {
    ...actual,
    emitIfSampled: (event: (typeof recorder.events)[number]) => {
      recorder.events.push(event);
    },
  };
});

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const ROUTE = "/api/dashboard/widgets";
const HANDLERS = { GET, PUT, DELETE } as const;

let ownerId: string;
let owner: SessionFixture;
let delegate: SessionFixture;
let tick = 0;

/** The cache key is a hash of the account id, which differs on every run. */
const VOLATILE = ["cache.dashboardWidgets.key_hash"];

/** A widget as the wire carries it: any id, so unknown ones can be sent. */
interface WireWidget {
  id: string;
  visible: boolean;
  tileVisible: boolean;
  order: number;
}

function fullLayout(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    widgets: DEFAULT_DASHBOARD_LAYOUT.widgets.map((w): WireWidget => ({
      id: w.id,
      visible: w.visible,
      tileVisible: w.tileVisible ?? w.visible,
      order: w.order,
    })),
    comparisonBaseline: "none",
    chartOverlayPrefs: {},
    selectedScoreRings: ["MED_COMPLIANCE"],
    heroRingOrder: ["HEALTH_SCORE", "MED_COMPLIANCE"],
    enabledHeroItemKinds: [],
    hero: "score",
    todayCardVisible: true,
    ...extra,
  };
}

async function stored() {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: ownerId },
    select: { dashboardWidgetsJson: true },
  });
  return row.dashboardWidgetsJson;
}

async function step(
  name: string,
  method: HttpMethod,
  options: {
    auth?: RouteAuth;
    body?: unknown;
    headers?: Record<string, string>;
    contract?: { skip: string };
  } = {},
): Promise<{ data: unknown }> {
  tick += 1;
  vi.setSystemTime(new Date(NOW.getTime() + tick * 1000));
  wideEventRecorder.take();
  const handler = HANDLERS[method as keyof typeof HANDLERS];
  const res = await callRoute(handler, {
    method,
    route: ROUTE,
    body: options.body,
    headers: options.headers,
    contract: options.contract,
    auth: options.auth ?? owner,
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  await expectParity(
    `dashboard-widgets.${name}`,
    stable(
      {
        status: res.status,
        body: res.body,
        events: events.map(eventFacts),
        stored: await stored(),
      },
      { since: NOW, volatileKeys: VOLATILE },
    ),
  );
  return { data: res.data };
}

function tokenOf(data: unknown): string {
  const token = (data as { updatedAt?: unknown } | null)?.updatedAt;
  if (typeof token !== "string") throw new Error("no updatedAt in response");
  return token;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const ownerRow = await makeUser({ timezone: "UTC" });
  ownerId = ownerRow.id;
  owner = await makeSession(ownerRow);
  const delegateRow = await makeUser({ timezone: "UTC" });
  delegate = await makeSession(delegateRow);
  await makeGrant(ownerRow, delegateRow, { access: "WRITE" });
});

afterAll(() => {
  vi.useRealTimers();
});

describe("/api/dashboard/widgets parity", () => {
  let lastToken = "";

  it("01 the first read, filled into the cache", async () => {
    const { data } = await step("01-get-default", "GET");
    lastToken = tokenOf(data);
  });

  it("02 the same read from the cache", async () => {
    await step("02-get-cached", "GET");
  });

  it("03 a full save carrying ids outside the catalogue", async () => {
    const body = fullLayout({ comparisonBaseline: "lastMonth" });
    body.widgets.push(
      { id: "retired-tile", visible: true, tileVisible: true, order: 90 },
      { id: "typo-tile", visible: false, tileVisible: false, order: 91 },
    );
    body.chartOverlayPrefs = {
      weight: {
        showTrendIndicator: true,
        showTrendArrow: false,
        showTargetRange: true,
        rangePoints: 30,
      },
    };
    const { data } = await step("03-put-full-unknown-ids", "PUT", { body });
    lastToken = tokenOf(data);
  });

  it("04 a partial save that keeps the stored fields and range", async () => {
    const { data } = await step("04-put-partial-preserve", "PUT", {
      body: {
        version: 1,
        chartOverlayPrefs: {
          weight: {
            showTrendIndicator: false,
            showTrendArrow: true,
            showTargetRange: false,
          },
          bp: {
            showTrendIndicator: true,
            showTrendArrow: true,
            showTargetRange: true,
          },
        },
        hero: "reminders",
      },
    });
    lastToken = tokenOf(data);
  });

  it("05 a body the schema refuses", async () => {
    await step("05-put-invalid", "PUT", {
      body: {
        version: 2,
        widgets: [{ id: "weight", visible: "yes", order: 1 }],
        comparisonBaseline: "lastDecade",
        password: "hunter2",
      },
    });
  });

  it("06 a request without a body", async () => {
    await step("06-put-empty-body", "PUT", {
      body: undefined,
      headers: { "content-type": "application/json" },
      // The registry declares no 400 for this operation; the parity walk
      // pins the answer the route gives, not the contract.
      contract: { skip: "400 for an unreadable body is not registered" },
    });
  });

  it("07 a junk base token", async () => {
    await step("07-put-invalid-base", "PUT", {
      body: { version: 1, baseUpdatedAt: 42, todayCardVisible: false },
    });
  });

  it("08 a stale base token", async () => {
    await step("08-put-stale-base", "PUT", {
      body: {
        version: 1,
        baseUpdatedAt: "2026-01-01T00:00:00.000Z",
        todayCardVisible: false,
      },
    });
  });

  it("09 a save on the current token", async () => {
    const { data } = await step("09-put-current-base", "PUT", {
      body: { version: 1, baseUpdatedAt: lastToken, todayCardVisible: false },
    });
    lastToken = tokenOf(data);
  });

  it("10 reads with recovery off, without HRV and with one series", async () => {
    await prisma.user.update({
      where: { id: ownerId },
      data: { modulePreferencesJson: { recovery: false } },
    });
    await step("10a-get-recovery-off-no-hrv", "GET");
    await makeMeasurement(
      { id: ownerId },
      {
        type: "HRV_RMSSD",
        value: 41,
        unit: "ms",
        measuredAt: new Date("2026-10-14T06:00:00.000Z"),
      },
    );
    await step("10b-get-recovery-off-rmssd", "GET");
  });

  it("11 a delegate reads the owner's layout and may not change it", async () => {
    await switchSessionTo(delegate.sessionId, ownerId);
    try {
      await step("11a-delegate-get", "GET", { auth: delegate });
      await step("11b-delegate-put", "PUT", {
        auth: delegate,
        body: { version: 1, comparisonBaseline: "lastYear" },
      });
      await step("11c-delegate-delete", "DELETE", { auth: delegate });
    } finally {
      await switchSessionTo(delegate.sessionId, null);
      headerJar.delete("x-healthlog-record-epoch");
      headerJar.delete("x-healthlog-record-scope");
    }
  });

  it("12 the owner resets the layout", async () => {
    await step("12-delete-reset", "DELETE");
  });

  it("13 the read after the reset", async () => {
    await step("13-get-after-reset", "GET");
  });

  it("14 an anonymous call", async () => {
    await step("14-anonymous-get", "GET", { auth: anonymous });
  });
});
