/**
 * `getSession` keeps `User.locale` in step with the language the browser is
 * actually reading.
 *
 * The column is the only signal a cookie-blind path has — the nightly
 * briefing warm, the Coach nudge, the reminder senders, the native dashboard
 * aggregate. The screen in front of the user resolves from the
 * `healthlog-locale` cookie first. When those two disagree nothing looks
 * wrong until a job writes a sentence, and then one paragraph of an
 * otherwise correct page comes back in the wrong language.
 *
 * Closing that used to be a fire-and-forget PUT from a mount effect, so a
 * lost request left the divergence standing for the life of the account.
 * These pin the server-side reconcile that replaced it as the mechanism.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const cookieState = vi.hoisted(() => ({
  sessionId: undefined as string | undefined,
  locale: undefined as string | undefined,
  set: vi.fn(),
  delete: vi.fn(),
}));

const store = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    session: {
      findUnique: vi.fn(async () => store.row),
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({})),
    },
    user: { update: vi.fn(async () => ({})) },
  },
}));

vi.mock("@/lib/logging/context", () => ({ getEvent: () => undefined }));

vi.mock("@/lib/auth/hmac", () => ({
  hashToken: (raw: string) => `hash:${raw}`,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      if (name === "healthlog_session" && cookieState.sessionId) {
        return { value: cookieState.sessionId };
      }
      if (name === "healthlog-locale" && cookieState.locale !== undefined) {
        return { value: cookieState.locale };
      }
      return undefined;
    },
    set: cookieState.set,
    delete: cookieState.delete,
  })),
}));

import { prisma } from "@/lib/db";
import { getSession } from "../session";

/** A cookie value in the shape `mintSessionSecret` produces. */
const SECRET = `hls_${"a".repeat(64)}`;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function seedSession(userLocale: string | null) {
  cookieState.sessionId = SECRET;
  store.row = {
    id: "sess-1",
    userId: "user-1",
    tokenHash: `hash:${SECRET}`,
    // Far enough out that the sliding-expiry refresh stays quiet.
    expiresAt: new Date(Date.now() + THIRTY_DAYS_MS),
    lastActiveAt: new Date(),
    actingAsUserId: null,
    recordEpoch: 0,
    user: { id: "user-1", locale: userLocale },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieState.locale = undefined;
  store.row = null;
});

describe("getSession — locale column reconcile", () => {
  it("writes the column when the browser reads a different language", async () => {
    // The row the production instance actually held: a German reader whose
    // column said English, so every generated sentence came back English.
    seedSession("en");
    cookieState.locale = "de";

    const result = await getSession();

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { locale: "de" },
    });
    // The same request must not answer with the value just replaced.
    expect(result?.user.locale).toBe("de");
  });

  it("backfills a column that was never written at all", async () => {
    // The account that never opened the language picker: the cookie is the
    // client's own mount-time write of the Accept-Language paint.
    seedSession(null);
    cookieState.locale = "de";

    await getSession();

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { locale: "de" },
    });
  });

  it("writes nothing once the two agree", async () => {
    seedSession("de");
    cookieState.locale = "de";

    await getSession();

    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("ignores a cookie value that is not a shipped locale", async () => {
    // The cookie is not HttpOnly, so anything can be in it. A value the
    // resolver would later have to defend against never reaches the column.
    seedSession("de");
    cookieState.locale = "tlh";

    const result = await getSession();

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(result?.user.locale).toBe("de");
  });

  it("re-emits the cookie instead of writing when the cookie is gone", async () => {
    // Safari ITP expired the script-written copy; the column is the
    // survivor, so it is the one that seeds the cookie, not the reverse.
    seedSession("de");
    cookieState.locale = undefined;

    await getSession();

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(cookieState.set).toHaveBeenCalledWith(
      "healthlog-locale",
      "de",
      expect.objectContaining({ httpOnly: false }),
    );
  });

  it("does not block the request on the write", async () => {
    // Fire-and-forget like the `lastActiveAt` stamp: a failing update must
    // not turn locale drift into a failed session resolution.
    seedSession("en");
    cookieState.locale = "de";
    vi.mocked(prisma.user.update).mockRejectedValueOnce(
      new Error("db down") as never,
    );

    await expect(getSession()).resolves.not.toBeNull();
  });
});
