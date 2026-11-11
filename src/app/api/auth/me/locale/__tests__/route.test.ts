/**
 * The language write on a demo.
 *
 * A demo is one published account every visitor signs into, so a visitor's
 * language must not become the account's: the route answers as usual and
 * sets the visitor's own cookie, but leaves the shared row alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return { ...actual, requireActorAuth: vi.fn() };
});
vi.mock("@/lib/db", () => ({ prisma: { user: { update: vi.fn() } } }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({})) }));
vi.mock("@/lib/i18n/locale-cookie", () => ({ setLocaleCookie: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

import { PUT } from "../route";
import { requireActorAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { setLocaleCookie } from "@/lib/i18n/locale-cookie";

const ORIGINAL_DEMO_MODE = process.env.DEMO_MODE;

function put(locale: string) {
  return PUT(
    new Request("http://localhost/api/auth/me/locale", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale }),
    }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireActorAuth).mockResolvedValue({
    user: { id: "demo-account", locale: "en" },
  } as never);
});

afterEach(() => {
  if (ORIGINAL_DEMO_MODE === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
});

describe("PUT /api/auth/me/locale", () => {
  it("stores the language on the account", async () => {
    delete process.env.DEMO_MODE;
    const res = await put("de");
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "demo-account" },
      data: { locale: "de" },
    });
  });

  it("keeps a demo visitor's language in their own cookie only", async () => {
    process.env.DEMO_MODE = "true";
    const res = await put("de");
    expect(res.status).toBe(200);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(setLocaleCookie).toHaveBeenCalledWith(expect.anything(), "de");
  });
});
