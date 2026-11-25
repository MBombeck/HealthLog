/**
 * Concurrent key writes to a document on the instance settings row keep
 * every key.
 *
 * The module availability and the server setup steps are JSON documents on
 * the one `app_settings` row. A write that changes one key reads the document,
 * merges the key in and writes it back. Without a lock, two writes that
 * overlap (two admins, or two steps settled at once) both read the same
 * document, and the later one drops the earlier one's key; on a fresh
 * instance the overlapping first writes also collide on creating the row. The
 * settings row lock (`withAppSettingsRowLock`) queues them. This file drives
 * each with overlapping writes and checks that every key arrived.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function signInAdmin(): Promise<void> {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: "settings-race-admin",
      email: "settings-race-admin@example.test",
      role: "ADMIN",
      onboardingCompletedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  const session = await prisma.session.create({
    data: { userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

type Handler = (req: Request) => Promise<Response>;

describe("concurrent instance settings writes", () => {
  it("keeps every module switched off in parallel, from a fresh instance on", async () => {
    await signInAdmin();
    const { PATCH } =
      await import("@/app/api/admin/settings/module-availability/route");
    const { MODULE_KEYS, SWITCH_OWNED_MODULE_KEYS } =
      await import("@/lib/modules/registry");
    const keys = MODULE_KEYS.filter(
      (key) => !SWITCH_OWNED_MODULE_KEYS.includes(key),
    ).slice(0, 6);
    expect(keys.length).toBe(6);
    // Twice: the first round starts with no settings row at all.
    for (const value of [false, true]) {
      const responses = await Promise.all(
        keys.map((key) =>
          (PATCH as Handler)(
            new Request(
              "http://localhost/api/admin/settings/module-availability",
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ [key]: value }),
              },
            ),
          ),
        ),
      );
      expect(responses.map((r) => r.status)).toEqual(keys.map(() => 200));
      const row = await getPrismaClient().appSettings.findUniqueOrThrow({
        where: { id: "singleton" },
        select: { moduleAvailabilityJson: true },
      });
      const stored = (row.moduleAvailabilityJson ?? {}) as Record<
        string,
        boolean
      >;
      for (const key of keys)
        expect(stored[key], `${key}=${value}`).toBe(value);
    }
  });

  it("keeps every server setup step settled in parallel and stamps the setup finished", async () => {
    const { writeServerSetupStep } =
      await import("@/lib/admin/server-setup-store");
    const { SERVER_SETUP_STEP_IDS } = await import("@/lib/admin/server-setup");
    await Promise.all(
      SERVER_SETUP_STEP_IDS.map((id) => writeServerSetupStep(id, "done")),
    );
    const row = await getPrismaClient().appSettings.findUniqueOrThrow({
      where: { id: "singleton" },
      select: { serverSetupStepsJson: true, serverSetupCompletedAt: true },
    });
    const steps = row.serverSetupStepsJson as { id: string; status: string }[];
    for (const id of SERVER_SETUP_STEP_IDS) {
      expect(steps.find((step) => step.id === id)?.status, id).toBe("done");
    }
    expect(row.serverSetupCompletedAt).not.toBeNull();
  });
});
