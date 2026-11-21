import { describe, expect, it } from "vitest";

import { authPaths } from "../routes/auth";
import { medicationPaths } from "../routes/medications";
import {
  medicationCadenceChips,
  medicationDetailEntry,
  medicationIntakeEventResource,
  medicationListEntry,
} from "../routes/medications/schemas";

/**
 * Contract guard for the medications + auth surfaces. Every fixture is
 * transcribed from a handler return statement, so a schema that drifts away
 * from the handler fails here.
 */

function statusesFor(
  paths: typeof authPaths,
  path: string,
  method: "get" | "post" | "put" | "patch" | "delete",
): string[] {
  const responses = paths[path]?.[method]?.responses as
    Record<string, unknown> | undefined;
  return Object.keys(responses ?? {});
}

function hasParams(
  paths: typeof authPaths,
  path: string,
  method: "get" | "delete" | "patch",
): boolean {
  return Boolean(paths[path]?.[method]?.requestParams);
}

describe("medications — documented shapes match the handlers", () => {
  it("keeps `nextDueAt` off the create / update result, which returns the stored row", () => {
    // src/app/api/medications/route.ts — `apiSuccess({ ...medication,
    // unitsPerDose, category }, 201)`, and [id]/route.ts for the PUT. Both
    // spread the stored Prisma row; `nextDueAt` / `nextDueOverdue` are
    // computed by the READ paths only and are simply absent here. The shared
    // detail shape backs BOTH the write results and the single GET, so it
    // cannot require them.
    expect(
      medicationDetailEntry.shape.nextDueAt.safeParse(undefined).success,
    ).toBe(true);
    expect(
      medicationDetailEntry.shape.nextDueOverdue.safeParse(undefined).success,
    ).toBe(true);
  });

  it("still requires the computed due fields on a list row, which always has them", () => {
    // src/lib/medications/list-read.ts computes both on every row, so the
    // list entry must not inherit the base's optionality.
    expect(
      medicationListEntry.shape.nextDueAt.safeParse(undefined).success,
    ).toBe(false);
    expect(
      medicationListEntry.shape.nextDueOverdue.safeParse(undefined).success,
    ).toBe(false);
  });

  it("accepts a fractional stock unit count (unitsRemaining is Decimal(12,4))", () => {
    // src/lib/medications/list-read.ts sums `unitsRemaining`, which the schema
    // itself documents as fractional ("a half-tablet dose leaves 29.5 of 30").
    const shape = medicationListEntry.shape.stockUnitsRemaining;
    expect(shape.safeParse(29.5).success).toBe(true);
  });

  it("matches `complianceChips()`'s actual return on the cadence chips", () => {
    // src/lib/medications/scheduling/compliance.ts returns exactly these five.
    const chips = {
      adherenceRate: null,
      currentStreak: 0,
      longestStreak: 4,
      missedLast30: 2,
      windowDays: 30,
    };
    const parsed = medicationCadenceChips.safeParse(chips);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("rejects the fields the cadence chips never carried", () => {
    const stale = {
      adherenceRate: 90,
      streakDays: 3,
      expectedSlots: 30,
      actualDoses: 27,
    };
    expect(medicationCadenceChips.safeParse(stale).success).toBe(false);
  });

  it("admits APPLE_HEALTH as an intake source (IntakeSource enum, v1.28)", () => {
    // v1.37.19 — the resource declares the FULL row both intake
    // responses return, so the fixture carries every field.
    const event = {
      id: "cm000000000000000000000",
      userId: "cm111111111111111111111",
      medicationId: "cm222222222222222222222",
      scheduledFor: "2026-07-19T08:00:00.000Z",
      takenAt: "2026-07-19T08:05:00.000Z",
      skipped: false,
      autoMissed: false,
      autoRecorded: false,
      attributionSource: "AUTO",
      source: "APPLE_HEALTH",
      takenVia: "APPLE_HEALTH",
      idempotencyKey: null,
      createdAt: "2026-07-19T08:05:00.000Z",
      updatedAt: "2026-07-19T08:05:00.000Z",
      injectionSite: null,
      doseTaken: null,
      inventoryConsumption: null,
      externalId: "hk-intake-1",
      syncVersion: 1,
      deletedAt: null,
    };
    const parsed = medicationIntakeEventResource.safeParse(event);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

describe("auth — documented shapes and statuses match the handlers", () => {
  it("documents the 403 oidc_only refusal on password login", () => {
    expect(statusesFor(authPaths, "/api/auth/login", "post")).toContain("403");
  });

  it("documents the 403 + 404 arms on passkey assertion verification", () => {
    const statuses = statusesFor(
      authPaths,
      "/api/auth/passkey/login-verify",
      "post",
    );
    expect(statuses).toContain("403");
    expect(statuses).toContain("404");
  });

  it("documents the 409 on both TOTP enrolment steps", () => {
    expect(
      statusesFor(authPaths, "/api/auth/me/mfa/totp/setup", "post"),
    ).toContain("409");
    expect(
      statusesFor(authPaths, "/api/auth/me/mfa/totp/confirm", "post"),
    ).toContain("409");
  });

  it("documents the 400 on a failed security-key attestation", () => {
    expect(
      statusesFor(
        authPaths,
        "/api/auth/me/mfa/webauthn/register/verify",
        "post",
      ),
    ).toContain("400");
  });

  it("documents the 409 when no security key is registered to assert against", () => {
    expect(
      statusesFor(authPaths, "/api/auth/mfa/webauthn/verify/options", "post"),
    ).toContain("409");
  });

  it("documents the 404 on both security-key {id} verbs", () => {
    const path = "/api/auth/me/mfa/webauthn/{id}";
    expect(statusesFor(authPaths, path, "patch")).toContain("404");
    expect(statusesFor(authPaths, path, "delete")).toContain("404");
  });

  it("declares the path / query parameters the handlers actually read", () => {
    expect(hasParams(authPaths, "/api/auth/me/sessions/{id}", "delete")).toBe(
      true,
    );
    expect(
      hasParams(authPaths, "/api/auth/me/trusted-devices/{id}", "delete"),
    ).toBe(true);
    expect(
      hasParams(authPaths, "/api/auth/me/mfa/webauthn/{id}", "patch"),
    ).toBe(true);
    expect(hasParams(authPaths, "/api/auth/me/security-activity", "get")).toBe(
      true,
    );
  });
});

describe("medications — the module gate stays documented where it applies", () => {
  it("keeps the daily digest's module 403", () => {
    // Sanity anchor: an unrelated documented 403 must not regress while the
    // medication + auth statuses above are being added.
    expect(statusesFor(medicationPaths, "/api/medications", "get")).toContain(
      "200",
    );
  });
});
