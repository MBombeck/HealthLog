/**
 * v1.4.15 Phase B2 — IntegrationStatus end-to-end (real Postgres).
 *
 * The unit suite (`src/lib/integrations/__tests__/status.test.ts`)
 * mocks Prisma. This file lights up the real driver so we lock in the
 * upsert + concurrent-write story AND prove that every sync failure
 * writes one `AuditLog` row with the documented schema:
 *
 *   action  : "integrations.sync.failed"
 *   userId  : <subject>
 *   details : { integration, kind, errorCode, message,
 *               attemptNumber, state }
 *
 * The dispatcher is mocked at module level so we don't actually hit
 * Telegram while testing — the assertion is on the alerting side
 * effects, not the network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Crypto reads `ENCRYPTION_KEY` lazily on first encrypt(). vitest does
// NOT load the dev `.env`, so we seed a deterministic 32-byte test key
// before any `@/lib/integrations/status` import — that module wraps
// `encrypt()` for the `lastError` column.
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// The dispatcher would otherwise try to read encrypted channel
// configs and call sendViaTelegram. We're not testing that path —
// B3 owns it. Stub returns void so the helper's await chain
// resolves cleanly.
vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn().mockResolvedValue(undefined),
}));

import {
  recordSyncFailure,
  recordSyncSuccess,
  markReauthRequired,
  markDisconnected,
  markReconnected,
  isReauthRequired,
  getIntegrationStatus,
  resumeIntegrationFromPark,
} from "@/lib/integrations/status";
import { dispatchNotification } from "@/lib/notifications/dispatcher";

const TEST_USER_ID = "user-integration-status-e2e";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "int-status-test",
      email: "int-status@example.test",
    },
  });
  vi.mocked(dispatchNotification).mockClear();
});

describe("IntegrationStatus end-to-end", () => {
  it("recordSyncFailure writes an integration_statuses row AND a matching AuditLog entry", async () => {
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "withings",
      kind: "transient",
      message: "Withings refresh error: 503 - upstream",
      errorCode: "503",
    });

    const status = await getPrismaClient().integrationStatus.findUnique({
      where: {
        userId_integration: {
          userId: TEST_USER_ID,
          integration: "withings",
        },
      },
    });
    expect(status).not.toBeNull();
    expect(status!.state).toBe("error_transient");
    // v1.4.47 W1 — legacy `consecutiveFailures` column dropped; the
    // per-kind bucket is now the sole counter.
    expect(status!.consecutiveFailuresByKind).toMatchObject({
      transient: 1,
      reauth_required: 0,
      persistent: 0,
    });
    expect(status!.lastAttemptAt).toBeInstanceOf(Date);
    expect(status!.lastError).toBeTruthy();
    // Encrypted at rest — must NOT be the plaintext message.
    expect(status!.lastError).not.toContain("Withings refresh error");

    const audits = await getPrismaClient().auditLog.findMany({
      where: { action: "integrations.sync.failed", userId: TEST_USER_ID },
    });
    expect(audits).toHaveLength(1);
    const detailsParsed = JSON.parse(audits[0].details ?? "{}");
    expect(detailsParsed).toMatchObject({
      integration: "withings",
      kind: "transient",
      errorCode: "503",
      message: "Withings refresh error: 503 - upstream",
      attemptNumber: 1,
      state: "error_transient",
    });
  });

  it("getIntegrationStatus returns plaintext error after roundtrip (decryption succeeds)", async () => {
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "moodlog",
      kind: "transient",
      message: "moodLog sync HTTP 502",
      errorCode: "http_502",
    });
    const snapshot = await getIntegrationStatus(TEST_USER_ID, "moodlog");
    expect(snapshot.state).toBe("error_transient");
    expect(snapshot.lastError).toBe("moodLog sync HTTP 502");
    // v1.4.47 W1 — snapshot drops the legacy `consecutiveFailures`
    // scalar; the per-kind bucket carries the count.
    expect(snapshot.consecutiveFailuresByKind).toMatchObject({
      transient: 1,
      reauth_required: 0,
      persistent: 0,
    });
  });

  it("recordSyncSuccess clears the streak, resets state, and (importantly) does NOT write an audit row", async () => {
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "withings",
      kind: "transient",
      message: "transient blip",
    });
    await recordSyncSuccess(TEST_USER_ID, "withings");

    const status = await getPrismaClient().integrationStatus.findUnique({
      where: {
        userId_integration: { userId: TEST_USER_ID, integration: "withings" },
      },
    });
    expect(status!.state).toBe("connected");
    expect(status!.consecutiveFailuresByKind).toMatchObject({
      transient: 0,
      reauth_required: 0,
      persistent: 0,
    });
    expect(status!.lastError).toBeNull();
    expect(status!.lastSuccessAt).toBeInstanceOf(Date);

    // Successes are NOT audited (would be too noisy — design choice).
    const successAudits = await getPrismaClient().auditLog.findMany({
      where: { action: "integrations.sync.success" },
    });
    expect(successAudits).toHaveLength(0);
  });

  it("crossing the default threshold (3) dispatches an admin Telegram alert exactly once per burst", async () => {
    // Seed an admin user so the alert resolution finds at least one
    // recipient. The dispatcher itself is stubbed.
    await getPrismaClient().user.create({
      data: {
        id: "admin-int-status-test",
        username: "admin-int-status",
        email: "admin@example.test",
        role: "ADMIN",
      },
    });

    // 3 consecutive failures in the same burst.
    for (let i = 0; i < 3; i++) {
      await recordSyncFailure({
        userId: TEST_USER_ID,
        integration: "withings",
        kind: "transient",
        message: "Withings refresh error: 503 - upstream",
        errorCode: "503",
      });
    }

    // Exactly one alert (on the 3rd failure crossing threshold).
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(dispatchNotification).mock.calls[0][0];
    expect(payload.eventType).toBe("SYSTEM_ALERT");
    expect(payload.userId).toBe("admin-int-status-test");

    // alertedAt is stamped — a 4th failure inside the 24h window must
    // NOT page again.
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "withings",
      kind: "transient",
      message: "Withings refresh error: 503 - upstream",
    });
    expect(dispatchNotification).toHaveBeenCalledTimes(1);

    // After a single success, a fresh streak starts and the next
    // burst is allowed to alert again.
    await recordSyncSuccess(TEST_USER_ID, "withings");
    for (let i = 0; i < 3; i++) {
      await recordSyncFailure({
        userId: TEST_USER_ID,
        integration: "withings",
        kind: "transient",
        message: "Withings refresh error: 503 - upstream",
      });
    }
    expect(dispatchNotification).toHaveBeenCalledTimes(2);
  });

  it("kind=reauth_required parks the integration so isReauthRequired() returns true", async () => {
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "moodlog",
      kind: "reauth_required",
      message: "moodLog sync HTTP 401",
      errorCode: "http_401",
    });
    expect(await isReauthRequired(TEST_USER_ID, "moodlog")).toBe(true);
    expect(await isReauthRequired(TEST_USER_ID, "withings")).toBe(false);
  });

  it("markReconnected clears the parked state without writing a fresh success", async () => {
    await markReauthRequired(TEST_USER_ID, "withings", "invalid_grant");
    expect(await isReauthRequired(TEST_USER_ID, "withings")).toBe(true);

    await markReconnected(TEST_USER_ID, "withings");
    expect(await isReauthRequired(TEST_USER_ID, "withings")).toBe(false);

    const row = await getPrismaClient().integrationStatus.findUnique({
      where: {
        userId_integration: { userId: TEST_USER_ID, integration: "withings" },
      },
    });
    expect(row!.state).toBe("connected");
    // No fresh lastSuccessAt — that's the next sync's job.
    expect(row!.lastSuccessAt).toBeNull();
  });

  it("markDisconnected wipes the error state but leaves the row as a tombstone", async () => {
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "moodlog",
      kind: "transient",
      message: "blip",
    });
    await markDisconnected(TEST_USER_ID, "moodlog");
    const row = await getPrismaClient().integrationStatus.findUnique({
      where: {
        userId_integration: { userId: TEST_USER_ID, integration: "moodlog" },
      },
    });
    expect(row!.state).toBe("disconnected");
    expect(row!.lastError).toBeNull();
    expect(row!.consecutiveFailuresByKind).toMatchObject({
      transient: 0,
      reauth_required: 0,
      persistent: 0,
    });
  });

  // v1.4.43 W14 — end-to-end resume flow against real Postgres.
  //
  // The full ladder: persistent failure × N → bucket increments only
  // the persistent slot → wall-clock crosses 24h → next failure flips
  // state to `parked` → resumeIntegrationFromPark clears it back to
  // connected → every bucket zeroed → the next sync runs.
  it("resumeIntegrationFromPark clears a parked row and zeroes every bucket", async () => {
    // Stamp a row that's already parked. We do it through Prisma
    // directly so the test doesn't have to wait 24h of wall clock.
    await getPrismaClient().integrationStatus.create({
      data: {
        userId: TEST_USER_ID,
        integration: "withings",
        state: "parked",
        consecutiveFailuresByKind: {
          transient: 2,
          reauth_required: 0,
          persistent: 28,
        },
        persistentFailureStartedAt: new Date(
          Date.now() - 26 * 60 * 60 * 1000,
        ),
        lastError: "encrypted-blob-placeholder",
        lastAttemptAt: new Date(),
      },
    });

    const result = await resumeIntegrationFromPark(TEST_USER_ID, "withings");
    expect(result.wasParked).toBe(true);

    const row = await getPrismaClient().integrationStatus.findUnique({
      where: {
        userId_integration: {
          userId: TEST_USER_ID,
          integration: "withings",
        },
      },
    });
    expect(row).not.toBeNull();
    expect(row!.state).toBe("connected");
    expect(row!.consecutiveFailuresByKind).toEqual({
      transient: 0,
      reauth_required: 0,
      persistent: 0,
    });
    expect(row!.persistentFailureStartedAt).toBeNull();
    expect(row!.lastError).toBeNull();

    // `isReauthRequired` no longer short-circuits the sync entry-point
    // — the next cron tick will attempt the upstream call.
    expect(await isReauthRequired(TEST_USER_ID, "withings")).toBe(false);
  });

  it("recordSyncFailure increments only the matching per-kind bucket", async () => {
    // First write — transient bucket goes to 1.
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "withings",
      kind: "transient",
      message: "Withings refresh error: 503",
      errorCode: "503",
    });
    let row = await getPrismaClient().integrationStatus.findUnique({
      where: {
        userId_integration: {
          userId: TEST_USER_ID,
          integration: "withings",
        },
      },
    });
    expect(row!.consecutiveFailuresByKind).toMatchObject({
      transient: 1,
      reauth_required: 0,
      persistent: 0,
    });

    // Second write — persistent failure ticks ONLY the persistent
    // bucket. The transient bucket is preserved at 1 (this is the
    // whole point of the per-kind counter — a transient hiccup must
    // not mask the persistent streak's true age).
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "withings",
      kind: "persistent",
      message: "Withings measure error: 293",
      errorCode: "293",
    });
    row = await getPrismaClient().integrationStatus.findUnique({
      where: {
        userId_integration: {
          userId: TEST_USER_ID,
          integration: "withings",
        },
      },
    });
    expect(row!.consecutiveFailuresByKind).toMatchObject({
      transient: 1,
      reauth_required: 0,
      persistent: 1,
    });
    // First persistent failure stamps the streak anchor.
    expect(row!.persistentFailureStartedAt).toBeInstanceOf(Date);
  });

  it("CASCADE delete on User removes the IntegrationStatus row", async () => {
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "withings",
      kind: "transient",
      message: "blip",
    });
    await getPrismaClient().user.delete({ where: { id: TEST_USER_ID } });
    const remaining = await getPrismaClient().integrationStatus.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(remaining).toHaveLength(0);
  });
});
