/**
 * A dose recorded on another surface reaches a relay-bound device as a
 * silent sync, whether or not the recorded-dose confirmation is on.
 *
 * The relay leg used to skip the silent sync whenever the flush carried a
 * recorded dose, on the assumption that the confirmation alert would trigger
 * the sync in the extension. The confirmation is opt-in and off by default
 * (on only for an account whose phone keeps its own reminders), so a pill
 * box take on a server without its own APNs key reached a server-reminded
 * device as neither: the widget and the app kept showing the dose as due.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-relay-intake-sync-ingest-32-bytes-min-123456";

import {
  FakeRelay,
  RELAY_PUBLIC_KEY,
  RELAY_URL,
  eventually,
} from "./push-relay-fake";

const relay = vi.hoisted(() => ({
  current: null as null | {
    handle: (url: string | URL, init?: RequestInit) => Promise<Response>;
  },
}));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: (url: string | URL, init?: RequestInit) => {
      if (!relay.current) throw new Error("no fake relay");
      return relay.current.handle(url, init);
    },
  };
});

import { getPrismaClient, truncateAllTables } from "./setup";
import { callRoute } from "../kit/call-route";
import { makeSession, makeToken, makeUser } from "../kit/factories";
import { deviceBody, enableRelay, registerDevice } from "./push-relay-kit";

const TOKEN = "4a".repeat(32);

let fake: FakeRelay;

beforeAll(() => {
  process.env.PUSH_RELAY_URL = RELAY_URL;
  process.env.PUSH_RELAY_KEYS = RELAY_PUBLIC_KEY;
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  fake = new FakeRelay();
  relay.current = fake;
});

describe("a dose recorded elsewhere wakes a relay device", () => {
  it("sends the silent sync to a server-reminded device when the confirmation is off", async () => {
    const { instanceId } = await enableRelay();
    const user = await makeUser();
    const session = await makeSession(user);
    const { body } = deviceBody(instanceId, TOKEN, {
      medicationDelivery: "server",
    });
    const registered = await registerDevice(session, body);
    expect(registered.data.push.relayState).toBe("bound");

    const prisma = getPrismaClient();
    const medication = await prisma.medication.create({
      data: { userId: user.id, name: "Ramipril", dose: "5 mg" },
    });
    const pillBox = await makeToken(user, {
      permissions: ["medication:ingest", `medication:${medication.id}:ingest`],
    });
    const { POST } = await import("@/app/api/ingest/medication/route");
    const res = await callRoute(POST, {
      method: "POST",
      route: "/api/ingest/medication",
      auth: pillBox,
      body: { medicationName: "Ramipril", idempotencyKey: "box-1" },
    });
    expect(res.status).toBe(201);

    await eventually(() => fake.apns.some((a) => a.pushClass === "silent"));
    // The confirmation is off for this account, so no alert stands in for
    // the sync.
    expect(fake.apns.some((a) => a.pushClass === "alert")).toBe(false);
  });
});
