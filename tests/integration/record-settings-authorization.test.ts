import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveGuardianRecordSettingsAccess } from "@/lib/record-settings/access";
import {
  classifySettingsDestination,
  SETTINGS_DESTINATION_INVENTORY,
} from "@/lib/record-settings/classification";
import { MANAGED_RECORD_SETTINGS_FIELD_ALLOWLIST } from "@/lib/record-settings";

const fromRoot = (...segments: string[]) => resolve(process.cwd(), ...segments);

describe("record settings authorization", () => {
  it("keeps actor and record separation", async () => {
    const [authMeRoute, recordSettingsRoute] = await Promise.all([
      readFile(fromRoot("src/app/api/auth/me/route.ts"), "utf8"),
      readFile(fromRoot("src/app/api/record-settings/route.ts"), "utf8"),
    ]);

    const access = resolveGuardianRecordSettingsAccess({
      actor: { id: "guardian-1" },
      grantId: "grant-1",
      user: { id: "managed-record-1", managedProfileAt: new Date() },
    });

    expect(access).toMatchObject({
      actorId: "guardian-1",
      recordId: "managed-record-1",
      recordKind: "managed",
      relationship: "guardian",
    });
    expect(authMeRoute).toContain("requireAuth");
    expect(authMeRoute).not.toContain("requireGuardianAuth");
    expect(authMeRoute).not.toContain("requireRecordAuth");
    expect(recordSettingsRoute).toContain("requireGuardianAuth");
    expect(recordSettingsRoute).toContain("toRecordSettingsDto");
  });

  it("keeps settings classification exhaustive and fail closed", () => {
    expect(Object.keys(SETTINGS_DESTINATION_INVENTORY)).not.toHaveLength(0);
    expect(classifySettingsDestination("integrations")).toMatchObject({
      kind: "managed-guardian",
      guardianWritable: false,
    });
    // #1403: the AI page holds a managed profile's automatic-reading switch,
    // a guardian write; a page with nothing of the profile's stays closed.
    expect(classifySettingsDestination("ai")).toMatchObject({
      kind: "managed-guardian",
      guardianWritable: true,
    });
    expect(classifySettingsDestination("environment").kind).toBe("unavailable");
    expect(classifySettingsDestination("unknown-settings-path").kind).toBe(
      "unavailable",
    );
  });

  it("uses one guardian-only record resolver for every writable DTO family", async () => {
    const route = await readFile(
      fromRoot("src/app/api/record-settings/[family]/route.ts"),
      "utf8",
    );
    const guardian = resolveGuardianRecordSettingsAccess({
      actor: { id: "guardian-1" },
      grantId: "grant-1",
      user: { id: "managed-record-1", managedProfileAt: new Date() },
    });
    const adultManager = resolveGuardianRecordSettingsAccess({
      actor: { id: "adult-manager" },
      grantId: "grant-1",
      user: { id: "adult-record-1", managedProfileAt: null },
    });

    expect(guardian?.recordId).toBe("managed-record-1");
    expect(adultManager).toBeNull();
    expect(route).toContain("requireGuardianAuth");
    expect(route).toContain("resolveGuardianRecordSettingsAccess");
    for (const family of Object.keys(MANAGED_RECORD_SETTINGS_FIELD_ALLOWLIST)) {
      expect(route).toContain(`case \"${family}\"`);
    }
    expect(route).toContain("record-settings.${family}.update");
    expect(route).toContain("userId: access.recordId");
    expect(route).toContain("actorUserId: access.actorId");
    // The audit row names what changed; a family may add closed-vocabulary
    // facts beside it (the AI source and chain kind), never an identifier.
    expect(route).toContain("details: { changed, ...auditExtra }");
    expect(route).not.toContain("details: { recordId:");
    // The zone and identity refresh is the one every writer of these fields
    // shares (medication day grid, zone cache, supplement recompute).
    expect(route).toContain("afterIdentityFieldsChanged(access.recordId, {");
    // The module write is one record-keyed function shared with the setup
    // flow's derivation; the health-score invalidation lives there, so the
    // route must call it with the record and the helper must still invalidate.
    expect(route).toContain("writeRecordModulePreferences({");
    expect(route).toContain("recordId: access.recordId,");
    expect(route).not.toContain("invalidateUserHealthScore(");
    const moduleWrite = await readFile(
      fromRoot("src/lib/record-settings/modules.ts"),
      "utf8",
    );
    expect(moduleWrite).toContain("invalidateUserHealthScore(input.recordId)");
    expect(route).toContain("getAllEffectiveRanges(record, overrides)");
    expect(route).toContain(
      "effective: getAllEffectiveRanges(record, overrides)",
    );
    // The thresholds write lives in `patchThresholdsSettings(recordId, ...)`,
    // called with `access.recordId`; the profile cache drops after it.
    expect(route).toContain(
      "patchThresholdsSettings(\n            access.recordId,",
    );
    expect(route).toContain("invalidateUserProfile(recordId)");
    expect(
      route.lastIndexOf("invalidateUserProfile(recordId)"),
    ).toBeGreaterThan(
      route.indexOf("data: { thresholdsJson: toJson(overrides) }"),
    );
  });
});
