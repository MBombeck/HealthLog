/**
 * A guardian reads the managed record's connections through the same
 * server-resolved `health` the record's owner would see, and only the
 * record's: a connection on the guardian's own account must not appear on
 * the record, and the record's connection must answer from the record's rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables, switchSessionTo } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

interface ManagedIntegration {
  integration: string;
  state: string;
  health: { state: string; reason: string } | null;
}

async function readIntegrations(): Promise<{
  recordId: string;
  integrations: ManagedIntegration[];
}> {
  const { GET } = await import("@/app/api/record-settings/integrations/route");
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("GET /api/record-settings/integrations", () => {
  it("publishes the record's own health per provider, never the guardian's", async () => {
    const prisma = getPrismaClient();
    const guardian = await prisma.user.create({
      data: {
        username: "health-guardian",
        email: "health-guardian@example.test",
        role: "USER",
        timezone: "Europe/Berlin",
        locale: "en",
        onboardingCompletedAt: new Date(),
        // The guardian's own Polar: must not surface on the record.
        polarAccessTokenEncrypted: "not-a-real-token",
      },
    });
    const { createManagedProfile } =
      await import("@/lib/managed-profiles/create");
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
      gender: null,
    });
    // The record's own Oura, synced once.
    await prisma.user.update({
      where: { id: profile.id },
      data: { ouraAccessTokenEncrypted: "not-a-real-token" },
    });
    const { recordSyncSuccess } = await import("@/lib/integrations/status");
    await recordSyncSuccess(profile.id, "oura");

    const session = await prisma.session.create({
      data: {
        userId: guardian.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    cookieJar.set("healthlog_session", session.id);
    await switchSessionTo(session.id, profile.id);

    const data = await readIntegrations();
    expect(data.recordId).toBe(profile.id);
    expect(data.integrations).toHaveLength(8);

    const byKey = new Map(data.integrations.map((i) => [i.integration, i]));
    const oura = byKey.get("oura");
    expect(oura?.health).not.toBeNull();
    expect(oura?.health?.state).toBe("ok");
    // Health and the legacy state agree on "a pipe exists".
    expect(oura?.state).toBe("connected");

    // The guardian's Polar is the guardian's, not the record's.
    expect(byKey.get("polar")?.health).toBeNull();
    for (const key of [
      "withings",
      "whoop",
      "fitbit",
      "nightscout",
      "google-health",
      "strava",
    ]) {
      expect(byKey.get(key)?.health, key).toBeNull();
    }
  });
});
