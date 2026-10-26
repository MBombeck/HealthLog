import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSource } from "@/__tests__/helpers/source-files";

/**
 * Runtime detection + once-per-state admin notification for the offline
 * GeoLite2 tier.
 *
 * The CI workflow drops an `.empty` marker into `assets/geolite2/`
 * whenever `MAXMIND_LICENSE_KEY` is unset, so the Docker COPY still
 * lands a non-empty directory in `/opt/geolite2/`. The runtime resolver
 * detects the marker on first fallback and fires a localised
 * notification to every admin, through the notice module registered in
 * its slot at boot (`src/lib/notifications/offline-geo-notice.ts`).
 *
 * Issue #851: the sent-latch used to be a module-level boolean, so every
 * worker boot re-sent the same notice while the configuration never
 * changed. The anchor now persists in the `notification_events` ledger
 * (via `claimNotificationEvent`) and is released when the state exits —
 * databases configured, or online lookups disabled. The tests pin the
 * full state machine:
 *
 *   1. Entering the unconfigured state sends, once, to every admin.
 *   2. Staying in the state — further lookups, and simulated worker
 *      restarts — stays silent.
 *   3. Leaving the state releases the anchor; re-entering sends again.
 *   4. `IP_GEO_LOOKUP_DISABLED=1` counts as having left the state: with
 *      no egress there is nothing to warn about.
 *
 * `mmdb-lib` is stubbed via the same shape the existing
 * `geo-asn.test.ts` uses; `fs` is left real because `offlineGeoReady`
 * reads real files at the temp-dir path picked per test. `@/lib/db` is
 * mocked with an in-memory `notification_events` store that outlives
 * `vi.resetModules()`, which is what lets a test simulate a restart
 * while the "database" keeps its rows. `safeFetch` is stubbed so the
 * online-fallback path never leaves the process.
 */

vi.mock("mmdb-lib", () => ({
  Reader: class {
    constructor(_buf: Buffer) {
      void _buf;
    }
    get(ip: string): unknown {
      void ip;
      return null;
    }
  },
}));

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: vi.fn(async () => ({ ok: false, status: 503 })),
}));

const dispatchSpy = vi.fn(async () => undefined);
vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: dispatchSpy,
}));

interface EventRow {
  recordUserId: string;
  eventType: string;
  dedupKey: string;
  createdAt: Date;
}

/** In-memory `notification_events` — survives `vi.resetModules()`. */
const eventStore: EventRow[] = [];

const findManySpy = vi.fn(async () => [{ id: "admin-1" }]);

const txStub = {
  $queryRaw: async () => [{ locked: 1 }],
  notificationEvent: {
    findFirst: async (args: {
      where: {
        recordUserId: string;
        eventType: string;
        dedupKey: string;
        createdAt: { gte: Date };
      };
    }) =>
      eventStore.find(
        (row) =>
          row.recordUserId === args.where.recordUserId &&
          row.eventType === args.where.eventType &&
          row.dedupKey === args.where.dedupKey &&
          row.createdAt >= args.where.createdAt.gte,
      ) ?? null,
    create: async (args: {
      data: { recordUserId: string; eventType: string; dedupKey: string };
    }) => {
      const row: EventRow = { ...args.data, createdAt: new Date() };
      eventStore.push(row);
      return row;
    },
  },
};

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: findManySpy },
    $transaction: async (fn: (tx: typeof txStub) => Promise<unknown>) =>
      fn(txStub),
    notificationEvent: {
      deleteMany: async (args: {
        where: { eventType: string; dedupKey: string };
      }) => {
        const before = eventStore.length;
        for (let i = eventStore.length - 1; i >= 0; i--) {
          if (
            eventStore[i].eventType === args.where.eventType &&
            eventStore[i].dedupKey === args.where.dedupKey
          ) {
            eventStore.splice(i, 1);
          }
        }
        return { count: before - eventStore.length };
      },
    },
  },
}));

const ORIGINAL_ENV = { ...process.env };
let tmpRoot: string;

async function flushMicrotasks(): Promise<void> {
  // The notification path is fire-and-forget — `void evaluate…()` —
  // and pulls in `@/lib/db` + `@/lib/notifications/dispatch-localised`
  // through dynamic `import()` calls, so each dispatch needs several
  // microtask + macrotask flushes before the spy registers the call.
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * The resolver plus the notice in its slot, the way a booted process has
 * them: `src/instrumentation.ts` registers the notice before any request.
 */
async function loadGeo(): Promise<typeof import("../geo")> {
  const geo = await import("../geo");
  const { registerOfflineGeoNotice } =
    await import("@/lib/notifications/offline-geo-notice");
  registerOfflineGeoNotice();
  return geo;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.IP_GEO_LOOKUP_DISABLED;
  tmpRoot = mkdtempSync(join(tmpdir(), "healthlog-geo-r5-"));
  process.env.GEOLITE2_DIR = tmpRoot;
  dispatchSpy.mockClear();
  findManySpy.mockClear();
  findManySpy.mockResolvedValue([{ id: "admin-1" }]);
  eventStore.length = 0;
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("offline-geo runtime detection", () => {
  it("evaluates nothing before the notice is registered, and runs on the first lookup after", async () => {
    writeFileSync(join(tmpRoot, ".empty"), "");
    const geo = await import("../geo");

    await geo.lookupIpLocation("8.8.8.8");
    await flushMicrotasks();
    expect(findManySpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();

    const { registerOfflineGeoNotice } =
      await import("@/lib/notifications/offline-geo-notice");
    registerOfflineGeoNotice();
    await geo.lookupIpLocation("1.1.1.1");
    await flushMicrotasks();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it("is registered at boot", () => {
    const boot = readSource(
      "src/instrumentation.ts",
      "registerOfflineGeoNotice",
    );
    expect(boot).toMatch(
      /import\("@\/lib\/notifications\/offline-geo-notice"\)[\s\S]*registerOfflineGeoNotice\(\)/,
    );
    // …and the helper that does it runs inside `register()`.
    const registerBody = boot.slice(
      boot.indexOf("export async function register()"),
    );
    expect(registerBody).toContain("await registerOfflineGeoNoticeAtBoot()");
  });

  it("offlineGeoReady() is false when the .empty marker is present", async () => {
    writeFileSync(join(tmpRoot, ".empty"), "");
    const { offlineGeoReady } = await loadGeo();
    expect(offlineGeoReady()).toBe(false);
  });

  it("offlineGeoReady() is false when the City MMDB is absent", async () => {
    const { offlineGeoReady } = await loadGeo();
    expect(offlineGeoReady()).toBe(false);
  });

  it("treats a blank GEOLITE2_DIR as unset rather than as the working directory", async () => {
    // A compose `${GEOLITE2_DIR:-}` substitutes to the EMPTY STRING, which
    // is not nullish. Without the trim, `path.join("", "GeoLite2-City.mmdb")`
    // is a RELATIVE path and the readiness check answers from whatever the
    // process working directory happens to hold. Proven by putting a stub
    // MMDB in the working directory and asserting the blank value still
    // resolves to the documented default (which has none).
    const originalCwd = process.cwd();
    writeFileSync(join(tmpRoot, "GeoLite2-City.mmdb"), Buffer.from("stub"));
    process.chdir(tmpRoot);
    try {
      process.env.GEOLITE2_DIR = "";
      const { offlineGeoReady } = await loadGeo();
      expect(offlineGeoReady()).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("offlineGeoReady() is true when the City MMDB is present and no marker", async () => {
    writeFileSync(
      join(tmpRoot, "GeoLite2-City.mmdb"),
      Buffer.from("city-stub"),
    );
    const { offlineGeoReady } = await loadGeo();
    expect(offlineGeoReady()).toBe(true);
  });

  it("fires the admin notification when the marker is present and lookupIpLocation falls back", async () => {
    writeFileSync(join(tmpRoot, ".empty"), "");
    const { lookupIpLocation } = await loadGeo();

    await lookupIpLocation("8.8.8.8");
    await flushMicrotasks();

    expect(findManySpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        titleKey: "notifications.admin.offlineGeoUnavailableTitle",
        messageKey: "notifications.admin.offlineGeoUnavailableBody",
        params: expect.objectContaining({
          host: "ipwho.is",
          docsUrl: expect.stringContaining("docs/self-hosting/geolite2.md"),
        }),
        metadata: expect.objectContaining({ source: "geo-offline-detection" }),
      }),
    );
  });

  it("names the real online provider in the notification params", async () => {
    writeFileSync(join(tmpRoot, ".empty"), "");
    process.env.IP_GEO_LOOKUP_URL = "https://ip-api.example/json";
    const { lookupIpLocation } = await loadGeo();

    await lookupIpLocation("8.8.8.8");
    await flushMicrotasks();

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ host: "ip-api.example" }),
      }),
    );
  });

  it("points the admin at a reachable action, never at a repository secret", async () => {
    // issue #659 — the message used to tell a self-hoster to set
    // MAXMIND_LICENSE_KEY in this repository's Actions secrets, which is
    // not something they can do. Every locale must name the mount instead.
    const locales = [
      "de",
      "en",
      "es",
      "fr",
      "it",
      "pl",
      "ko",
      "nl",
      "pt-BR",
    ] as const;
    for (const locale of locales) {
      const bundle = JSON.parse(
        readFileSync(
          join(__dirname, `../../../messages/${locale}.json`),
          "utf8",
        ),
      ) as {
        notifications: { admin: { offlineGeoUnavailableBody: string } };
      };
      const body = bundle.notifications.admin.offlineGeoUnavailableBody;
      expect(body, `${locale} still names a build-time secret`).not.toMatch(
        /MAXMIND_LICENSE_KEY|GitHub|Actions|secret/i,
      );
      expect(body, `${locale} does not name the reachable override`).toContain(
        "GEOLITE2_DIR",
      );
      expect(body, `${locale} drops the {host} placeholder`).toContain(
        "{host}",
      );
      expect(body, `${locale} drops the {docsUrl} placeholder`).toContain(
        "{docsUrl}",
      );
    }
  });

  it("does NOT fire the notification when the City MMDB is present", async () => {
    writeFileSync(
      join(tmpRoot, "GeoLite2-City.mmdb"),
      Buffer.from("city-stub"),
    );
    // The stubbed reader returns null for every IP, which is fine — the
    // lookup will still go through the online path, but the offline
    // check sees a healthy directory so the notification stays silent.
    const { lookupIpLocation } = await loadGeo();

    await lookupIpLocation("8.8.8.8");
    await flushMicrotasks();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(findManySpy).not.toHaveBeenCalled();
  });

  it("does NOT fire the notification when online lookups are disabled", async () => {
    // With IP_GEO_LOOKUP_DISABLED=1 no address leaves the host, so there
    // is no egress for the notice to warn about — the disabled host has
    // left the state exactly like one that mounted the databases.
    writeFileSync(join(tmpRoot, ".empty"), "");
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    const { lookupIpLocation } = await loadGeo();

    await lookupIpLocation("8.8.8.8");
    await flushMicrotasks();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(findManySpy).not.toHaveBeenCalled();
  });

  it("fires the notification exactly once across repeated fallbacks in one process", async () => {
    writeFileSync(join(tmpRoot, ".empty"), "");
    const { lookupIpLocation, lookupIpAsn } = await loadGeo();

    await lookupIpLocation("8.8.8.8");
    await flushMicrotasks();
    await lookupIpLocation("1.1.1.1");
    await flushMicrotasks();
    lookupIpAsn("9.9.9.9");
    await flushMicrotasks();

    // Three fallbacks, exactly one dispatch.
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back silently when no admin user is configured", async () => {
    writeFileSync(join(tmpRoot, ".empty"), "");
    findManySpy.mockResolvedValueOnce([]);
    const { lookupIpLocation } = await loadGeo();

    await lookupIpLocation("8.8.8.8");
    await flushMicrotasks();

    expect(findManySpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("lookupIpAsn fires the notification when the ASN reader is missing and the marker is set", async () => {
    writeFileSync(join(tmpRoot, ".empty"), "");
    const { lookupIpAsn } = await loadGeo();

    const result = lookupIpAsn("8.8.8.8");
    await flushMicrotasks();

    expect(result).toBeNull();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it("is once per configuration state: silent across restarts, resent only after exit + re-entry (issue #851)", async () => {
    const cityDb = join(tmpRoot, "GeoLite2-City.mmdb");

    // ── Boot 1: unconfigured → the notice goes out and anchors durably.
    writeFileSync(join(tmpRoot, ".empty"), "");
    let geo = await loadGeo();
    await geo.lookupIpLocation("8.8.8.8");
    await flushMicrotasks();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(eventStore).toHaveLength(1);

    // ── Boot 2: worker restart, state unchanged → the persisted anchor
    // keeps it silent. This is the #851 repeat, pinned closed.
    vi.resetModules();
    geo = await loadGeo();
    await geo.lookupIpLocation("8.8.8.8");
    await flushMicrotasks();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(eventStore).toHaveLength(1);

    // ── Boot 3: the operator mounts the databases → state exits, the
    // anchor is released, still no new send.
    unlinkSync(join(tmpRoot, ".empty"));
    writeFileSync(cityDb, Buffer.from("city-stub"));
    vi.resetModules();
    geo = await loadGeo();
    await geo.lookupIpLocation("8.8.8.8");
    await flushMicrotasks();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(eventStore).toHaveLength(0);

    // ── Boot 4: the databases are gone again → genuine re-entry into the
    // unconfigured state, and the notice fires afresh.
    unlinkSync(cityDb);
    writeFileSync(join(tmpRoot, ".empty"), "");
    vi.resetModules();
    geo = await loadGeo();
    await geo.lookupIpLocation("8.8.8.8");
    await flushMicrotasks();
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    expect(eventStore).toHaveLength(1);
  });

  it("re-evaluates after a runtime database fetch resets the reader cache", async () => {
    // The runtime GeoLite2 fetch calls `resetGeoLite2ReaderCache()` after
    // placing fresh databases. The next lookup must observe the healthy
    // state and release the anchor without waiting for a restart.
    writeFileSync(join(tmpRoot, ".empty"), "");
    const geo = await loadGeo();

    await geo.lookupIpLocation("8.8.8.8");
    await flushMicrotasks();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(eventStore).toHaveLength(1);

    unlinkSync(join(tmpRoot, ".empty"));
    writeFileSync(
      join(tmpRoot, "GeoLite2-City.mmdb"),
      Buffer.from("city-stub"),
    );
    geo.resetGeoLite2ReaderCache();

    await geo.lookupIpLocation("1.1.1.1");
    await flushMicrotasks();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(eventStore).toHaveLength(0);
  });
});
