/**
 * v1.42.2 — a mood quick answer from a notification writes exactly once.
 *
 * The three answers on one reminder share a nonce, and the write is keyed on
 * it through `MoodEntry`'s unique `(userId, source, externalId)`. Against
 * real Postgres and the real route: the first answer logs, a repeat of the
 * same answer, a different answer on the same reminder, and two answers
 * racing each other all leave exactly one row behind.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "user-notification-action";

function call(token: string) {
  return import("@/app/api/notifications/action/[token]/route").then(
    ({ POST }) =>
      POST(
        new NextRequest(`http://localhost/api/notifications/action/${token}`, {
          method: "POST",
        }),
        { params: Promise.resolve({ token }) },
      ),
  );
}

async function tokens(nonce: string) {
  const { mintActionToken } = await import("@/lib/notifications/action-token");
  return {
    good: mintActionToken({ userId: USER, action: "mood-good", nonce }),
    bad: mintActionToken({ userId: USER, action: "mood-bad", nonce }),
  };
}

beforeEach(async () => {
  vi.stubEnv(
    "API_TOKEN_HMAC_KEY",
    "integration-hmac-key-at-least-32-characters",
  );
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: USER,
      username: "notification-action",
      email: "notification-action@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

describe("POST /api/notifications/action/{token}", () => {
  it("logs the first answer once and refuses every later answer on the reminder", async () => {
    const { good, bad } = await tokens("reminder-1");

    const first = await call(good);
    expect(first.status).toBe(200);
    const repeat = await call(good);
    expect(repeat.status).toBe(409);
    const other = await call(bad);
    expect(other.status).toBe(409);

    const rows = await getPrismaClient().moodEntry.findMany({
      where: { userId: USER },
      select: { source: true, externalId: true, score: true, mood: true },
    });
    expect(rows).toEqual([
      {
        source: "NOTIFICATION",
        externalId: "notification-action:reminder-1",
        score: 4,
        mood: "GUT",
      },
    ]);
  });

  it("lets only one of two racing answers write", async () => {
    const { good, bad } = await tokens("reminder-2");

    const statuses = (await Promise.all([call(good), call(bad)]))
      .map((res) => res.status)
      .sort();
    expect(statuses).toEqual([200, 409]);
    expect(
      await getPrismaClient().moodEntry.count({ where: { userId: USER } }),
    ).toBe(1);
  });

  it("answers a separate reminder with its own entry", async () => {
    const one = await tokens("reminder-3");
    const two = await tokens("reminder-4");
    expect((await call(one.good)).status).toBe(200);
    expect((await call(two.bad)).status).toBe(200);
    expect(
      await getPrismaClient().moodEntry.count({ where: { userId: USER } }),
    ).toBe(2);
  });

  it("refuses the reminder again after its entry was deleted and purged", async () => {
    const { good, bad } = await tokens("reminder-purged");
    expect((await call(good)).status).toBe(200);

    // Delete and purge inside the token's lifetime: the row that held the
    // unique key is gone.
    await getPrismaClient().moodEntry.deleteMany({ where: { userId: USER } });

    expect((await call(good)).status).toBe(409);
    expect((await call(bad)).status).toBe(409);
    expect(
      await getPrismaClient().moodEntry.count({ where: { userId: USER } }),
    ).toBe(0);
  });
});

/**
 * #1203 — the request in ntfy's own shape, from the published message to the
 * row. The action is taken from the JSON body `buildNtfyMessage` publishes,
 * and sent the way ntfy's Android app sends an `http` action: POST, empty
 * body, no cookie, no Origin, an okhttp user agent. It goes through the real
 * proxy first and then the real route, with the route param taken from the
 * URL path the way Next derives it.
 */
describe("a ntfy http action through the proxy and the route", () => {
  async function ntfyAction() {
    const { buildMoodQuickActions } =
      await import("@/lib/notifications/action-token");
    const { buildNtfyMessage } =
      await import("@/lib/notifications/senders/ntfy");
    const quickActions = buildMoodQuickActions({
      userId: USER,
      origin: "https://health.example.test",
      labels: { "mood-good": "Good", "mood-okay": "Okay", "mood-bad": "Bad" },
    });
    const message = buildNtfyMessage("topic", {
      userId: USER,
      eventType: "MOOD_REMINDER",
      title: "Mood",
      message: "How are you?",
      quickActions,
    } as Parameters<typeof buildNtfyMessage>[1]);
    // Round-trip through JSON: what the phone holds is the parsed publish body.
    const published = JSON.parse(JSON.stringify(message)) as typeof message;
    const okay = published.actions?.find((a) => a.label === "Okay");
    if (!okay) throw new Error("no Okay action in the published message");
    return okay;
  }

  async function send(method: string, url: string) {
    const { proxy } = await import("@/proxy");
    const request = new NextRequest(url, {
      method,
      headers: { "user-agent": "okhttp/4.12.0", "content-length": "0" },
      ...(method === "POST" ? { body: "" } : {}),
    });
    const edge = proxy(request);
    if (edge.headers.get("x-middleware-next") !== "1") return edge;
    const token = decodeURIComponent(
      new URL(url).pathname.split("/").pop() ?? "",
    );
    const { POST } =
      await import("@/app/api/notifications/action/[token]/route");
    return POST(request, { params: Promise.resolve({ token }) });
  }

  it("logs the mood when the phone POSTs the published action", async () => {
    const action = await ntfyAction();
    expect(action).toMatchObject({ action: "http", method: "POST" });

    const res = await send(action.method, action.url);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { logged: true, action: "mood-okay" },
    });
    const rows = await getPrismaClient().moodEntry.findMany({
      where: { userId: USER },
      select: { source: true, score: true },
    });
    expect(rows).toEqual([{ source: "NOTIFICATION", score: 3 }]);
  });

  it("refuses a GET (a POST a redirect rewrote) at the proxy and writes nothing", async () => {
    const action = await ntfyAction();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await send("GET", action.url);
      expect(res.status).toBe(405);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("method_not_allowed");
    } finally {
      warn.mockRestore();
    }
    expect(
      await getPrismaClient().moodEntry.count({ where: { userId: USER } }),
    ).toBe(0);
  });
});
