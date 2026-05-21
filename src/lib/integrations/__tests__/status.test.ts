/**
 * v1.4.15 Phase B2 — IntegrationStatus helper tests.
 *
 * The persistence path is exercised by the integration suite under
 * `tests/integration/integration-status.test.ts` (real Postgres so the
 * upsert + concurrent-update story holds). This file is the unit-level
 * suite for the threshold + alerting state machine — Prisma is mocked so
 * we control every input and observe the exact sequence of calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    integrationStatus: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/crypto", () => ({
  // Deterministic encrypt/decrypt for assertion stability.
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) =>
    s.startsWith("enc(") && s.endsWith(")") ? s.slice(4, -1) : s,
}));

import {
  recordSyncFailure,
  recordSyncSuccess,
  markReauthRequired,
  markDisconnected,
  markReconnected,
  isReauthRequired,
  getPersistentFailureThreshold,
  resumeIntegrationFromPark,
} from "../status";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { dispatchNotification } from "@/lib/notifications/dispatcher";

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.INTEGRATION_FAILURE_ALERT_THRESHOLD;
});

describe("getPersistentFailureThreshold", () => {
  it("defaults to 3 when env var is unset", () => {
    expect(getPersistentFailureThreshold()).toBe(3);
  });

  it("respects INTEGRATION_FAILURE_ALERT_THRESHOLD when set to a positive integer", () => {
    process.env.INTEGRATION_FAILURE_ALERT_THRESHOLD = "5";
    expect(getPersistentFailureThreshold()).toBe(5);
  });

  it("falls back to 3 when env var is non-numeric", () => {
    process.env.INTEGRATION_FAILURE_ALERT_THRESHOLD = "many";
    expect(getPersistentFailureThreshold()).toBe(3);
  });

  it("falls back to 3 when env var is zero or negative", () => {
    process.env.INTEGRATION_FAILURE_ALERT_THRESHOLD = "0";
    expect(getPersistentFailureThreshold()).toBe(3);
    process.env.INTEGRATION_FAILURE_ALERT_THRESHOLD = "-2";
    expect(getPersistentFailureThreshold()).toBe(3);
  });
});

describe("recordSyncSuccess", () => {
  it("upserts the row with state=connected, resets streak, clears alertedAt", async () => {
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce(
      {} as never,
    );
    await recordSyncSuccess("u1", "withings");
    const args = vi.mocked(prisma.integrationStatus.upsert).mock.calls[0][0];
    expect(args.where).toEqual({
      userId_integration: { userId: "u1", integration: "withings" },
    });
    expect(args.update).toEqual({
      state: "connected",
      lastSuccessAt: expect.any(Date),
      lastAttemptAt: expect.any(Date),
      lastError: null,
      consecutiveFailures: 0,
      // v1.4.43 W14 — success clears every per-kind bucket too so
      // the next failure starts from zero in its own bucket.
      consecutiveFailuresByKind: {
        transient: 0,
        reauth_required: 0,
        persistent: 0,
      },
      persistentFailureStartedAt: null,
      alertedAt: null,
    });
  });
});

describe("recordSyncFailure — under threshold", () => {
  it("increments the counter and does NOT dispatch an admin alert", async () => {
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 1,
    } as never);

    await recordSyncFailure({
      userId: "u1",
      integration: "withings",
      kind: "transient",
      message: "Withings refresh error: 503 - upstream",
    });

    expect(prisma.integrationStatus.upsert).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledWith(
      "integrations.sync.failed",
      expect.objectContaining({
        userId: "u1",
        details: expect.objectContaining({
          integration: "withings",
          attemptNumber: 1,
          state: "error_transient",
        }),
      }),
    );
    expect(dispatchNotification).not.toHaveBeenCalled();
  });
});

describe("recordSyncFailure — at threshold", () => {
  it("dispatches an admin Telegram alert when failure count reaches default threshold (3)", async () => {
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 3,
      alertedAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      email: "user@example.com",
    } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: "admin-1" },
      { id: "admin-2" },
    ] as never);
    vi.mocked(prisma.integrationStatus.update).mockResolvedValueOnce(
      {} as never,
    );

    await recordSyncFailure({
      userId: "u1",
      integration: "withings",
      kind: "transient",
      message: "Withings refresh error: 503 - upstream service down",
      errorCode: "503",
    });

    expect(dispatchNotification).toHaveBeenCalledTimes(2);
    const firstCallPayload = vi.mocked(dispatchNotification).mock.calls[0][0];
    expect(firstCallPayload.eventType).toBe("SYSTEM_ALERT");
    expect(firstCallPayload.userId).toBe("admin-1");
    expect(firstCallPayload.title).toContain(
      "Withings sync failing for user@example.com",
    );
    expect(firstCallPayload.message).toContain("3 times in a row");
    expect(firstCallPayload.message).toContain("503");
    expect(firstCallPayload.metadata).toEqual({
      integration: "withings",
      affectedUserId: "u1",
      consecutiveFailures: 3,
      errorCode: "503",
    });

    // alertedAt is stamped to gate re-alerting for 24h.
    expect(prisma.integrationStatus.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_integration: { userId: "u1", integration: "withings" },
        },
        data: expect.objectContaining({ alertedAt: expect.any(Date) }),
      }),
    );
  });

  it("uses the custom threshold from INTEGRATION_FAILURE_ALERT_THRESHOLD", async () => {
    process.env.INTEGRATION_FAILURE_ALERT_THRESHOLD = "5";
    // 4 < 5 → should not page yet
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 4,
      alertedAt: null,
    } as never);
    await recordSyncFailure({
      userId: "u1",
      integration: "moodlog",
      kind: "transient",
      message: "moodLog sync HTTP 502",
    });
    expect(dispatchNotification).not.toHaveBeenCalled();
  });
});

describe("recordSyncFailure — alert window", () => {
  it("does NOT dispatch a second alert within 24h on the same streak", async () => {
    const now = Date.now();
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 4,
      alertedAt: new Date(now - 60 * 60 * 1000), // 1h ago
    } as never);

    await recordSyncFailure({
      userId: "u1",
      integration: "withings",
      kind: "transient",
      message: "Withings refresh error: 503 - upstream",
    });

    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("DOES dispatch a fresh alert after 24h have elapsed", async () => {
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 6,
      alertedAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      email: "u@example.com",
    } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: "admin-1" },
    ] as never);
    vi.mocked(prisma.integrationStatus.update).mockResolvedValueOnce(
      {} as never,
    );

    await recordSyncFailure({
      userId: "u1",
      integration: "withings",
      kind: "transient",
      message: "Withings refresh error: 503 - upstream",
    });

    expect(dispatchNotification).toHaveBeenCalledOnce();
  });
});

describe("recordSyncFailure — reauth_required", () => {
  it("marks state=error_reauth and audits with kind=reauth_required", async () => {
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 1,
    } as never);
    await recordSyncFailure({
      userId: "u1",
      integration: "withings",
      kind: "reauth_required",
      message: "Withings refresh error: 100 - invalid_grant",
      errorCode: "100",
    });
    const upsertArgs = vi.mocked(prisma.integrationStatus.upsert).mock
      .calls[0][0];
    expect(upsertArgs.update).toMatchObject({ state: "error_reauth" });
    expect(auditLog).toHaveBeenCalledWith(
      "integrations.sync.failed",
      expect.objectContaining({
        details: expect.objectContaining({
          kind: "reauth_required",
          errorCode: "100",
        }),
      }),
    );
  });
});

describe("recordSyncFailure — persistent (v1.4.42 W6)", () => {
  it("marks state=error_transient (next sync still runs) and audits with kind=persistent", async () => {
    // Contract-mismatch failures (Withings 293 invalid params) MUST
    // surface in the audit log with kind=persistent so operations can
    // grep for upstream contract bugs, but they MUST NOT park the
    // integration — the next sync should still run because the
    // mismatch can be one-sided (e.g. Withings introducing a new
    // required field that the client release fixes).
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 1,
    } as never);
    await recordSyncFailure({
      userId: "u1",
      integration: "withings",
      kind: "persistent",
      message: "Withings measure error: 293 - invalid params",
      errorCode: "293",
    });
    const upsertArgs = vi.mocked(prisma.integrationStatus.upsert).mock
      .calls[0][0];
    expect(upsertArgs.update).toMatchObject({ state: "error_transient" });
    expect(auditLog).toHaveBeenCalledWith(
      "integrations.sync.failed",
      expect.objectContaining({
        details: expect.objectContaining({
          kind: "persistent",
          errorCode: "293",
        }),
      }),
    );
  });

  it("at threshold, the admin alert message includes the 'persistent error' label", async () => {
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 3,
      alertedAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      email: "user@example.com",
    } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: "admin-1" },
    ] as never);
    vi.mocked(prisma.integrationStatus.update).mockResolvedValueOnce(
      {} as never,
    );

    await recordSyncFailure({
      userId: "u1",
      integration: "withings",
      kind: "persistent",
      message: "Withings activity error: 293",
      errorCode: "293",
    });

    expect(dispatchNotification).toHaveBeenCalledOnce();
    const payload = vi.mocked(dispatchNotification).mock.calls[0][0];
    expect(payload.message).toContain("persistent error");
    expect(payload.message).toContain("Action: investigate the upstream contract");
  });
});

describe("recordSyncFailure — admin Telegram skipped silently when no admins", () => {
  it("logs a wide-event warning but does NOT throw when no admin users exist", async () => {
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 3,
      alertedAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      email: "u@example.com",
    } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([] as never);
    vi.mocked(prisma.integrationStatus.update).mockResolvedValueOnce(
      {} as never,
    );

    await expect(
      recordSyncFailure({
        userId: "u1",
        integration: "withings",
        kind: "transient",
        message: "Withings refresh error: 503 - upstream",
      }),
    ).resolves.toBeUndefined();

    expect(dispatchNotification).not.toHaveBeenCalled();
  });
});

describe("isReauthRequired", () => {
  it("returns true when state === error_reauth", async () => {
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce({
      state: "error_reauth",
    } as never);
    expect(await isReauthRequired("u1", "withings")).toBe(true);
  });

  it("returns true when state === parked (v1.4.43 W14)", async () => {
    // A parked integration must short-circuit the sync entry-point
    // the same way a reauth-required one does — neither will succeed
    // without user / operator action.
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce({
      state: "parked",
    } as never);
    expect(await isReauthRequired("u1", "withings")).toBe(true);
  });

  it("returns false for transient errors and absent rows", async () => {
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce({
      state: "error_transient",
    } as never);
    expect(await isReauthRequired("u1", "withings")).toBe(false);

    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce(null);
    expect(await isReauthRequired("u1", "withings")).toBe(false);
  });
});

describe("markReauthRequired / markDisconnected / markReconnected", () => {
  it("markReauthRequired: writes encrypted error + audit entry", async () => {
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce(
      {} as never,
    );
    await markReauthRequired("u1", "withings", "invalid grant");
    expect(prisma.integrationStatus.upsert).toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      "integrations.reauth_required",
      expect.objectContaining({ userId: "u1" }),
    );
  });

  it("markDisconnected: state=disconnected, clears errors & alertedAt", async () => {
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce(
      {} as never,
    );
    await markDisconnected("u1", "moodlog");
    const args = vi.mocked(prisma.integrationStatus.upsert).mock.calls[0][0];
    expect(args.update).toEqual({
      state: "disconnected",
      lastError: null,
      consecutiveFailures: 0,
      // v1.4.43 W14 — disconnect must clear the per-kind buckets too.
      consecutiveFailuresByKind: {
        transient: 0,
        reauth_required: 0,
        persistent: 0,
      },
      persistentFailureStartedAt: null,
      alertedAt: null,
    });
  });

  it("markReconnected: state=connected, clears prior reauth state", async () => {
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce(
      {} as never,
    );
    await markReconnected("u1", "withings");
    const args = vi.mocked(prisma.integrationStatus.upsert).mock.calls[0][0];
    expect(args.update).toEqual({
      state: "connected",
      lastError: null,
      consecutiveFailures: 0,
      // v1.4.43 W14 — reconnect clears the per-kind buckets so the
      // next sync starts on a clean slate.
      consecutiveFailuresByKind: {
        transient: 0,
        reauth_required: 0,
        persistent: 0,
      },
      persistentFailureStartedAt: null,
      alertedAt: null,
    });
  });
});

// ── v1.4.43 W14 — per-kind buckets + 24h park behaviour ────────────────
//
// The four pins below lock in the B4 + B7 contract:
//
//   1. A persistent failure increments ONLY the persistent bucket;
//      an intervening transient failure does NOT reset the persistent
//      streak.
//   2. The persistent-streak start timestamp is stamped on the FIRST
//      persistent failure of a streak and preserved across subsequent
//      persistent failures.
//   3. Once the persistent streak has been running for >24h, the state
//      flips to `parked` and an `integrations.parked` audit row is
//      written.
//   4. `resumeIntegrationFromPark` clears state back to `connected`,
//      zeroes every bucket, and writes an `integrations.resumed` audit
//      row (only when the row was actually parked — idempotent for
//      non-parked inputs).

describe("recordSyncFailure — v1.4.43 W14 per-kind buckets", () => {
  it("increments ONLY the matching bucket on each failure", async () => {
    // Existing row: transient bucket already at 2 from earlier hiccups.
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce({
      consecutiveFailures: 2,
      consecutiveFailuresByKind: {
        transient: 2,
        reauth_required: 0,
        persistent: 0,
      },
      persistentFailureStartedAt: null,
      alertedAt: null,
    } as never);
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 3,
      alertedAt: null,
    } as never);

    await recordSyncFailure({
      userId: "u1",
      integration: "withings",
      kind: "persistent",
      message: "Withings measure error: 293 - invalid params",
      errorCode: "293",
    });

    const upsertArgs = vi.mocked(prisma.integrationStatus.upsert).mock
      .calls[0][0];
    // transient stays at 2 (unchanged), persistent ticks to 1,
    // reauth_required stays at 0.
    expect(upsertArgs.update.consecutiveFailuresByKind).toEqual({
      transient: 2,
      reauth_required: 0,
      persistent: 1,
    });
    // First-ever persistent failure stamps the streak anchor.
    expect(upsertArgs.update.persistentFailureStartedAt).toBeInstanceOf(Date);
  });

  it("preserves persistentFailureStartedAt across multiple persistent failures", async () => {
    const streakStart = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce({
      consecutiveFailures: 5,
      consecutiveFailuresByKind: {
        transient: 0,
        reauth_required: 0,
        persistent: 5,
      },
      persistentFailureStartedAt: streakStart,
      alertedAt: new Date(Date.now() - 30 * 60 * 1000), // already alerted
    } as never);
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 6,
      alertedAt: new Date(Date.now() - 30 * 60 * 1000),
    } as never);

    await recordSyncFailure({
      userId: "u1",
      integration: "withings",
      kind: "persistent",
      message: "Withings measure error: 293",
      errorCode: "293",
    });

    const upsertArgs = vi.mocked(prisma.integrationStatus.upsert).mock
      .calls[0][0];
    // The anchor is preserved exactly — that's the whole point of
    // tracking the streak start instead of recomputing it from
    // updated_at.
    expect(upsertArgs.update.persistentFailureStartedAt).toBe(streakStart);
    expect(upsertArgs.update.state).toBe("error_transient"); // < 24h still
    expect(upsertArgs.update.consecutiveFailuresByKind).toEqual({
      transient: 0,
      reauth_required: 0,
      persistent: 6,
    });
  });

  it("a transient failure does NOT reset the persistent bucket nor the streak anchor", async () => {
    const streakStart = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6h ago
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce({
      consecutiveFailures: 4,
      consecutiveFailuresByKind: {
        transient: 0,
        reauth_required: 0,
        persistent: 4,
      },
      persistentFailureStartedAt: streakStart,
      alertedAt: null,
    } as never);
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 5,
      alertedAt: null,
    } as never);

    await recordSyncFailure({
      userId: "u1",
      integration: "withings",
      kind: "transient",
      message: "Withings refresh error: 503",
      errorCode: "503",
    });

    const upsertArgs = vi.mocked(prisma.integrationStatus.upsert).mock
      .calls[0][0];
    // Persistent bucket UNCHANGED — this is the v1.4.43 W14 fix.
    // Under the legacy single-counter behaviour the burst above would
    // have shown as "5 consecutive failures, state=error_transient"
    // and the persistent streak's age would have been masked.
    expect(upsertArgs.update.consecutiveFailuresByKind).toEqual({
      transient: 1,
      reauth_required: 0,
      persistent: 4,
    });
    expect(upsertArgs.update.persistentFailureStartedAt).toBe(streakStart);
  });

  it("flips state to `parked` and writes an audit row once persistent streak > 24h", async () => {
    const streakStart = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce({
      consecutiveFailures: 30,
      consecutiveFailuresByKind: {
        transient: 0,
        reauth_required: 0,
        persistent: 30,
      },
      persistentFailureStartedAt: streakStart,
      alertedAt: new Date(Date.now() - 23 * 60 * 60 * 1000),
    } as never);
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 31,
      alertedAt: new Date(Date.now() - 23 * 60 * 60 * 1000),
    } as never);

    await recordSyncFailure({
      userId: "u1",
      integration: "withings",
      kind: "persistent",
      message: "Withings measure error: 293",
      errorCode: "293",
    });

    const upsertArgs = vi.mocked(prisma.integrationStatus.upsert).mock
      .calls[0][0];
    expect(upsertArgs.update.state).toBe("parked");
    expect(auditLog).toHaveBeenCalledWith(
      "integrations.parked",
      expect.objectContaining({
        userId: "u1",
        details: expect.objectContaining({
          integration: "withings",
          reason: "persistent_24h",
          persistentFailureStartedAt: streakStart.toISOString(),
        }),
      }),
    );
  });

  it("back-fills the bucket from the legacy single counter on a pre-migration row", async () => {
    // Legacy row: counter is 3, no bucket JSON yet (predates 0075).
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce({
      consecutiveFailures: 3,
      consecutiveFailuresByKind: null,
      persistentFailureStartedAt: null,
      alertedAt: null,
    } as never);
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce({
      consecutiveFailures: 4,
      alertedAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      email: "u@example.com",
    } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([] as never);
    vi.mocked(prisma.integrationStatus.update).mockResolvedValueOnce(
      {} as never,
    );

    await recordSyncFailure({
      userId: "u1",
      integration: "withings",
      kind: "reauth_required",
      message: "Withings refresh error: 100 - invalid_grant",
      errorCode: "100",
    });

    const upsertArgs = vi.mocked(prisma.integrationStatus.upsert).mock
      .calls[0][0];
    // The 3 legacy failures get bucketed into the CURRENT failure's
    // kind (reauth_required) — that's the kind the row was last
    // tagged with, and back-filling into a different kind would
    // under-count the existing streak. v1.4.43 W10 senior-dev M-1 —
    // the back-fill branch additionally increments the bucket so the
    // post-write bucket count matches the legacy column's post-write
    // value (legacy: 3 → 4, bucket: 0 → 3 → 4).
    expect(upsertArgs.update.consecutiveFailuresByKind).toEqual({
      transient: 0,
      reauth_required: 4,
      persistent: 0,
    });
  });
});

describe("resumeIntegrationFromPark", () => {
  it("clears a parked row back to connected with all buckets zeroed", async () => {
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce({
      state: "parked",
    } as never);
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce(
      {} as never,
    );

    const result = await resumeIntegrationFromPark("u1", "withings");
    expect(result.wasParked).toBe(true);

    const upsertArgs = vi.mocked(prisma.integrationStatus.upsert).mock
      .calls[0][0];
    expect(upsertArgs.update).toEqual({
      state: "connected",
      lastError: null,
      consecutiveFailures: 0,
      consecutiveFailuresByKind: {
        transient: 0,
        reauth_required: 0,
        persistent: 0,
      },
      persistentFailureStartedAt: null,
      alertedAt: null,
    });

    expect(auditLog).toHaveBeenCalledWith(
      "integrations.resumed",
      expect.objectContaining({
        userId: "u1",
        details: expect.objectContaining({ integration: "withings" }),
      }),
    );
  });

  it("is idempotent — calling against a non-parked row does NOT write an audit row", async () => {
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce({
      state: "connected",
    } as never);
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce(
      {} as never,
    );

    const result = await resumeIntegrationFromPark("u1", "withings");
    expect(result.wasParked).toBe(false);
    expect(auditLog).not.toHaveBeenCalled();
  });
});
