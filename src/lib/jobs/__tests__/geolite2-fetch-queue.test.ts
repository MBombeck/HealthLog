/**
 * Runtime GeoLite2 fetch (issue #659) — queue-wiring guard + boot gating.
 *
 * The first half reads the worker registry: the queue is declared in the
 * maintenance group, scheduled monthly, and bound to the handler that runs
 * the fetch, and the maintenance boot discovery carries the fetch pass. An
 * unregistered queue silently never drains (the dead-queue class), which here
 * would mean a keyed self-host never gets its databases fetched.
 *
 * The second half exercises the boot-discovery gate directly: it must send a
 * job only when a key is set, egress is not disabled, and the offline tier is
 * absent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GEOLITE2_FETCH_CRON,
  GEOLITE2_FETCH_QUEUE,
} from "@/lib/jobs/geolite2-fetch";
import { handleGeolite2Fetch } from "@/lib/jobs/reminder/ops-handlers";
import {
  discoveryOf,
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

const handlerSource = readFileSync(
  join(__dirname, "..", "reminder", "ops-handlers.ts"),
  "utf8",
);

describe("geolite2-fetch registration", () => {
  it("declares the queue in the maintenance group", () => {
    expect(groupOf(GEOLITE2_FETCH_QUEUE).name).toBe("maintenance");
  });

  it("schedules the monthly cron with the default retries", () => {
    const job = jobOf(GEOLITE2_FETCH_QUEUE);
    expect(job.cron).toBe(GEOLITE2_FETCH_CRON);
    expect(job.scheduleOptions).toBeUndefined();
  });

  it("binds the fetch handler", async () => {
    expect(await loadedHandler(GEOLITE2_FETCH_QUEUE)).toBe(handleGeolite2Fetch);
  });

  it("runs the fetch inside the handler", () => {
    expect(handlerSource).toMatch(
      /handleGeolite2Fetch[\s\S]{0,500}fetchGeoLite2Databases/,
    );
  });

  it("fires the boot discovery from the maintenance group", () => {
    expect(discoveryOf("maintenance")).toContain("geolite2-fetch");
  });
});

// ── Boot-discovery gate ──────────────────────────────────────────────
const { sendMock, bossMock, offlineGeoReadyMock } = vi.hoisted(() => {
  const sendMock = vi.fn().mockResolvedValue("job-1");
  return {
    sendMock,
    bossMock: { send: sendMock },
    offlineGeoReadyMock: vi.fn(),
  };
});
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => bossMock,
}));
vi.mock("@/lib/geo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/geo")>();
  return { ...actual, offlineGeoReady: offlineGeoReadyMock };
});

import { enqueueGeolite2FetchBootDiscovery } from "@/lib/jobs/geolite2-fetch";

const ORIGINAL_KEY = process.env.MAXMIND_LICENSE_KEY;
const ORIGINAL_DISABLED = process.env.IP_GEO_LOOKUP_DISABLED;

describe("enqueueGeolite2FetchBootDiscovery — gating", () => {
  beforeEach(() => {
    sendMock.mockClear();
    sendMock.mockResolvedValue("job-1");
    offlineGeoReadyMock.mockReturnValue(false);
    process.env.MAXMIND_LICENSE_KEY = "test-key";
    delete process.env.IP_GEO_LOOKUP_DISABLED;
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.MAXMIND_LICENSE_KEY;
    else process.env.MAXMIND_LICENSE_KEY = ORIGINAL_KEY;
    if (ORIGINAL_DISABLED === undefined)
      delete process.env.IP_GEO_LOOKUP_DISABLED;
    else process.env.IP_GEO_LOOKUP_DISABLED = ORIGINAL_DISABLED;
  });

  it("enqueues a boot-mode fetch when keyed and no database is present", async () => {
    const { enqueued } = await enqueueGeolite2FetchBootDiscovery();
    expect(enqueued).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [queue, payload] = sendMock.mock.calls[0];
    expect(queue).toBe("geolite2-fetch");
    expect(payload).toMatchObject({ mode: "boot" });
  });

  it("skips when no MAXMIND_LICENSE_KEY is set", async () => {
    delete process.env.MAXMIND_LICENSE_KEY;
    const { enqueued } = await enqueueGeolite2FetchBootDiscovery();
    expect(enqueued).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips when IP_GEO_LOOKUP_DISABLED=1", async () => {
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    const { enqueued } = await enqueueGeolite2FetchBootDiscovery();
    expect(enqueued).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips when the offline tier is already present", async () => {
    offlineGeoReadyMock.mockReturnValue(true);
    const { enqueued } = await enqueueGeolite2FetchBootDiscovery();
    expect(enqueued).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
