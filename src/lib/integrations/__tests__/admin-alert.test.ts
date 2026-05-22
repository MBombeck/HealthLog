/**
 * v1.4.15 Phase B2, criterion 3 — admin Telegram alert formatting.
 *
 * The state-machine threshold tests live in `status.test.ts` (when
 * does the alert fire?). This file proves WHAT the alert looks like
 * — the message body the maintainer sees on Telegram when an integration
 * starts crashing for one of his users.
 *
 * The formatter is a pure function so we can test deterministically
 * without touching Prisma or the dispatcher.
 *
 * v1.4.27 — additionally asserts `parkIntegrationAtReauth` semantics:
 * the helper writes the row but neither increments the failure counter
 * nor pages admins through the dispatcher. The two scope-skip
 * call-sites in `withings/sync-{activity,sleep}.ts` must use this
 * helper rather than `recordSyncFailure`.
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
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) =>
    s.startsWith("enc(") && s.endsWith(")") ? s.slice(4, -1) : s,
}));

import { formatAdminAlertPayload, parkIntegrationAtReauth } from "../status";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { dispatchNotification } from "@/lib/notifications/dispatcher";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("formatAdminAlertPayload — Withings re-auth", () => {
  it("uses the integration display name (Withings, not 'withings')", () => {
    const out = formatAdminAlertPayload({
      userId: "u-1",
      integration: "withings",
      kind: "reauth_required",
      message: "Withings refresh error: 100 - invalid_grant",
      errorCode: "100",
      consecutiveFailures: 3,
      subjectLabel: "user@example.com",
    });
    expect(out.title).toBe("Withings sync failing for user@example.com");
    expect(out.message).toContain("Withings sync has failed 3 times in a row");
    expect(out.message).toContain("re-auth required");
    expect(out.message).toContain("(100)");
    expect(out.message).toContain(
      "Action: ask the user to reconnect the integration.",
    );
  });

  it("falls back to userId when no email/subjectLabel provided", () => {
    const out = formatAdminAlertPayload({
      userId: "user-no-email",
      integration: "withings",
      kind: "transient",
      message: "Withings refresh error: 503 - upstream",
      errorCode: "503",
      consecutiveFailures: 5,
    });
    expect(out.title).toBe("Withings sync failing for user-no-email");
  });
});

describe("formatAdminAlertPayload — moodLog transient", () => {
  it("uses 'moodLog' display name and the 'investigate the upstream service.' action", () => {
    const out = formatAdminAlertPayload({
      userId: "u-2",
      integration: "moodlog",
      kind: "transient",
      message: "moodLog sync HTTP 502",
      errorCode: "http_502",
      consecutiveFailures: 4,
      subjectLabel: "marc@example.com",
    });
    expect(out.title).toBe("moodLog sync failing for marc@example.com");
    expect(out.message).toContain("Action: investigate the upstream service.");
    expect(out.message).toContain("(http_502)");
  });
});

describe("formatAdminAlertPayload — message trimming", () => {
  it("trims a 4 KB stack trace down to 280 chars + ellipsis", () => {
    const longMessage = "stack: " + "x".repeat(4000);
    const out = formatAdminAlertPayload({
      userId: "u-3",
      integration: "withings",
      kind: "transient",
      message: longMessage,
      errorCode: undefined,
      consecutiveFailures: 3,
      subjectLabel: "user@example.com",
    });
    // Body line includes the trimmed message — full 4 KB MUST NOT
    // appear, but the start of the message MUST.
    expect(out.message).toContain("stack: ");
    expect(out.message).not.toContain("x".repeat(280));
    expect(out.message).toContain("...");
    // Whole message under 4096 (Telegram cap).
    expect(out.message.length).toBeLessThan(4096);
  });

  it("does NOT add an ellipsis when message is under the trim threshold", () => {
    const out = formatAdminAlertPayload({
      userId: "u-4",
      integration: "withings",
      kind: "transient",
      message: "short error",
      errorCode: undefined,
      consecutiveFailures: 3,
      subjectLabel: "user@example.com",
    });
    expect(out.message).toContain("short error");
    expect(out.message).not.toMatch(/short error\.\.\./);
  });
});

describe("formatAdminAlertPayload — metadata payload", () => {
  it("returns the metadata block with affectedUserId, consecutiveFailures, errorCode (or null)", () => {
    const withCode = formatAdminAlertPayload({
      userId: "u-5",
      integration: "withings",
      kind: "transient",
      message: "503",
      errorCode: "503",
      consecutiveFailures: 3,
    });
    expect(withCode.metadata).toEqual({
      integration: "withings",
      affectedUserId: "u-5",
      consecutiveFailures: 3,
      errorCode: "503",
    });

    const withoutCode = formatAdminAlertPayload({
      userId: "u-6",
      integration: "moodlog",
      kind: "transient",
      message: "blip",
      errorCode: undefined,
      consecutiveFailures: 7,
    });
    expect(withoutCode.metadata).toEqual({
      integration: "moodlog",
      affectedUserId: "u-6",
      consecutiveFailures: 7,
      errorCode: null,
    });
  });
});

describe("formatAdminAlertPayload — omits errorCode parens when undefined", () => {
  it("does not render '(undefined)' when no errorCode is supplied", () => {
    const out = formatAdminAlertPayload({
      userId: "u-7",
      integration: "withings",
      kind: "transient",
      message: "network reset",
      errorCode: undefined,
      consecutiveFailures: 3,
      subjectLabel: "user@example.com",
    });
    expect(out.message).not.toContain("(undefined)");
    expect(out.message).toContain("transient error — network reset");
  });
});

describe("parkIntegrationAtReauth — silent scope-skip park (v1.4.27 F20)", () => {
  it("sets state=error_reauth without incrementing consecutiveFailures and without paging admins", async () => {
    // Pre-existing row at counter=87 — the maintainer's reported
    // surviving-deploy state. The first scope-skip after the v1.4.27
    // deploy must NOT push the row to 88 and must NOT trigger the
    // 3-strike alert ladder.
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce({
      state: "error_transient",
      lastError: "enc(old)",
    } as never);
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce(
      {} as never,
    );

    await parkIntegrationAtReauth({
      userId: "u1",
      integration: "withings",
      message: "Withings connection is missing the user.activity scope.",
      errorCode: "scope_missing",
    });

    const upsertArgs = vi.mocked(prisma.integrationStatus.upsert).mock
      .calls[0][0];
    expect(upsertArgs.update).toMatchObject({
      state: "error_reauth",
      lastError: "enc(Withings connection is missing the user.activity scope.)",
    });
    // The whole point of the helper: counter is not in the update set.
    // v1.4.47 W1 — the legacy `consecutiveFailures` column was dropped
    // (migration 0076); the per-kind bucket is the live counter now.
    // Neither field appears in the update payload — the existing
    // bucket values are preserved exactly.
    expect(upsertArgs.update).not.toHaveProperty("consecutiveFailures");
    expect(upsertArgs.update).not.toHaveProperty("consecutiveFailuresByKind");

    // No admin alert fired.
    expect(dispatchNotification).not.toHaveBeenCalled();

    // A standalone reauth audit row IS written so the ops trail still
    // shows the park event — but it lands on
    // `integrations.reauth_required`, not `integrations.sync.failed`.
    expect(auditLog).toHaveBeenCalledWith(
      "integrations.reauth_required",
      expect.objectContaining({
        userId: "u1",
        details: expect.objectContaining({
          integration: "withings",
          errorCode: "scope_missing",
          source: "scope_skip",
        }),
      }),
    );
    expect(auditLog).not.toHaveBeenCalledWith(
      "integrations.sync.failed",
      expect.anything(),
    );
  });

  it("is idempotent on the audit log — a second call for the same scope-skip writes no extra audit row", async () => {
    // First call: row already parked with the same lastError. The
    // helper detects "no fresh park" and skips the audit write.
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce({
      state: "error_reauth",
      lastError: "enc(Withings connection is missing the user.activity scope.)",
    } as never);
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce(
      {} as never,
    );

    await parkIntegrationAtReauth({
      userId: "u1",
      integration: "withings",
      message: "Withings connection is missing the user.activity scope.",
      errorCode: "scope_missing",
    });

    // Upsert still runs (it's the "set lastAttemptAt" touch), but the
    // audit log is unchanged.
    expect(prisma.integrationStatus.upsert).toHaveBeenCalledOnce();
    expect(auditLog).not.toHaveBeenCalled();
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("creates a fresh row at counter=0 when no row exists yet", async () => {
    // First-ever sync attempt on a legacy connection: no row in the
    // table. Helper must create the row at counter=0 so a later
    // genuine transient burst still has the full 3-strike runway.
    // v1.4.47 W1 — counter is now the per-kind bucket payload (the
    // legacy `consecutiveFailures` column was dropped in migration
    // 0076); a zero envelope is the equivalent seed.
    vi.mocked(prisma.integrationStatus.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.integrationStatus.upsert).mockResolvedValueOnce(
      {} as never,
    );

    await parkIntegrationAtReauth({
      userId: "u-new",
      integration: "withings",
      message: "scope missing",
      errorCode: "scope_missing",
    });

    const upsertArgs = vi.mocked(prisma.integrationStatus.upsert).mock
      .calls[0][0];
    expect(upsertArgs.create).toMatchObject({
      userId: "u-new",
      integration: "withings",
      state: "error_reauth",
      consecutiveFailuresByKind: {
        transient: 0,
        reauth_required: 0,
        persistent: 0,
      },
    });
    expect(dispatchNotification).not.toHaveBeenCalled();
  });
});
