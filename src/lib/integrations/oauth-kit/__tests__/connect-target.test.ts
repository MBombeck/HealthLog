import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, update, findActiveGrant, auditLog } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(async () => ({})),
  findActiveGrant: vi.fn(),
  auditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique, update } } }));
vi.mock("@/lib/auth/audit", () => ({ auditLog }));
vi.mock("@/lib/sharing/grant-access", () => ({
  findActiveGrant,
  grantAllows: (
    grant: { access: string; revokedAt: Date | null },
    need: string,
  ) =>
    grant.revokedAt === null &&
    (need !== "manage" || grant.access === "MANAGE"),
}));

import {
  releaseSharedClientApp,
  releaseUnbackedClientApps,
  shareGuardianClientApp,
  verifyCallbackActor,
} from "../connect-target";
import { Prisma } from "@/generated/prisma/client";

const MANAGED = { managedProfileAt: new Date("2026-01-01T00:00:00Z") };
const ADULT = { managedProfileAt: null };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyCallbackActor", () => {
  it("admits the record's own session without a lookup", async () => {
    await expect(verifyCallbackActor("rec", "rec")).resolves.toEqual({
      ok: true,
      guardianUserId: null,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("keeps the session-less own-account path for an ordinary account", async () => {
    findUnique.mockResolvedValue(ADULT);
    await expect(verifyCallbackActor("rec", null)).resolves.toEqual({
      ok: true,
      guardianUserId: null,
    });
  });

  it("refuses another person's session on an ordinary account, grant or not", async () => {
    findUnique.mockResolvedValue(ADULT);
    findActiveGrant.mockResolvedValue({ access: "MANAGE", revokedAt: null });
    await expect(verifyCallbackActor("rec", "other")).resolves.toEqual({
      ok: false,
      reason: "cross_user",
    });
    expect(findActiveGrant).not.toHaveBeenCalled();
  });

  it("admits a guardian with a live MANAGE grant on a managed profile", async () => {
    findUnique.mockResolvedValue(MANAGED);
    findActiveGrant.mockResolvedValue({ access: "MANAGE", revokedAt: null });
    await expect(verifyCallbackActor("rec", "guardian")).resolves.toEqual({
      ok: true,
      guardianUserId: "guardian",
    });
    expect(findActiveGrant).toHaveBeenCalledWith({
      grantorId: "rec",
      granteeId: "guardian",
    });
  });

  it("refuses a read or write grant, and a grant revoked on the consent screen", async () => {
    findUnique.mockResolvedValue(MANAGED);
    findActiveGrant.mockResolvedValueOnce({ access: "WRITE", revokedAt: null });
    await expect(verifyCallbackActor("rec", "g")).resolves.toMatchObject({
      ok: false,
    });
    findActiveGrant.mockResolvedValueOnce(null);
    await expect(verifyCallbackActor("rec", "g")).resolves.toMatchObject({
      ok: false,
    });
  });

  it("requires a guardian's session for a managed profile", async () => {
    findUnique.mockResolvedValue(MANAGED);
    await expect(verifyCallbackActor("rec", null)).resolves.toEqual({
      ok: false,
      reason: "guardian_session_required",
    });
  });

  it("refuses a record that does not exist", async () => {
    findUnique.mockResolvedValue(null);
    await expect(verifyCallbackActor("gone", null)).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("shareGuardianClientApp", () => {
  const target = { recordUserId: "rec", actorUserId: "guardian" };

  it("does nothing on a person's own connect", async () => {
    const has = vi.fn(async () => false);
    await shareGuardianClientApp(
      "oura",
      { recordUserId: "a", actorUserId: "a" },
      has,
    );
    expect(has).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("does nothing when the profile already resolves an app", async () => {
    await shareGuardianClientApp("oura", target, async () => true);
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("copies the guardian's sealed app onto the profile and audits it", async () => {
    findUnique.mockResolvedValue({
      ouraClientIdEncrypted: "sealed-id",
      ouraClientSecretEncrypted: "sealed-secret",
    });
    await shareGuardianClientApp("oura", target, async () => false);
    expect(update).toHaveBeenCalledWith({
      where: { id: "rec" },
      data: {
        ouraClientIdEncrypted: "sealed-id",
        ouraClientSecretEncrypted: "sealed-secret",
        clientAppSharedBy: { oura: "guardian" },
      },
    });
    expect(auditLog).toHaveBeenCalledWith("integration.client_app.shared", {
      userId: "rec",
      actorUserId: "guardian",
      details: { provider: "oura" },
    });
  });

  it("copies nothing when the guardian has no app either", async () => {
    findUnique.mockResolvedValue({
      stravaClientIdEncrypted: null,
      stravaClientSecretEncrypted: null,
    });
    await shareGuardianClientApp("strava", target, async () => false);
    expect(update).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });
});

describe("releasing a borrowed provider app", () => {
  it("removes the borrowed app on disconnect and audits it", async () => {
    findUnique.mockResolvedValue({
      clientAppSharedBy: { oura: "guardian", strava: "guardian" },
    });
    await expect(
      releaseSharedClientApp("oura", "rec", "disconnected"),
    ).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith({
      where: { id: "rec" },
      data: {
        ouraClientIdEncrypted: null,
        ouraClientSecretEncrypted: null,
        clientAppSharedBy: { strava: "guardian" },
      },
    });
    expect(auditLog).toHaveBeenCalledWith(
      "integration.client_app.removed",
      expect.objectContaining({
        userId: "rec",
        details: {
          provider: "oura",
          reason: "disconnected",
          sharedBy: "guardian",
        },
      }),
    );
  });

  it("leaves an app the record holds of its own", async () => {
    findUnique.mockResolvedValue({ clientAppSharedBy: null });
    await expect(
      releaseSharedClientApp("oura", "rec", "disconnected"),
    ).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("clears the marker when the last borrowed app goes", async () => {
    findUnique.mockResolvedValue({ clientAppSharedBy: { polar: "g" } });
    await releaseSharedClientApp("polar", "rec", "guardian_left");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientAppSharedBy: Prisma.DbNull }),
      }),
    );
  });

  it("removes only the apps of guardians without a live MANAGE grant", async () => {
    findUnique.mockResolvedValue({
      clientAppSharedBy: { oura: "left", strava: "stays" },
    });
    findActiveGrant.mockImplementation(
      async ({ granteeId }: { granteeId: string }) =>
        granteeId === "stays" ? { access: "MANAGE", revokedAt: null } : null,
    );
    await expect(releaseUnbackedClientApps("rec")).resolves.toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ouraClientIdEncrypted: null,
          ouraClientSecretEncrypted: null,
        }),
      }),
    );
  });
});
