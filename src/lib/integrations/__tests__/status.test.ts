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
  it("returns true only when state === error_reauth", async () => {
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce({
      state: "error_reauth",
    } as never);
    expect(await isReauthRequired("u1", "withings")).toBe(true);

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
      alertedAt: null,
    });
  });
});
