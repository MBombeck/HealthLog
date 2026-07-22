import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: { user: { update: vi.fn() } },
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
  setOnboardingPendingCookie: vi.fn(),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST as disclaimerPost } from "../disclaimer/route";
import { POST as tourPost } from "../tour/route";
import { POST as completePost } from "../complete/route";
import { getSession } from "@/lib/auth/session";

const SESSION = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 60_000) },
  user: {
    id: "u1",
    username: "user",
    role: "USER" as const,
    onboardingTourCompleted: false,
  },
};

function req(path: string, body: unknown) {
  return new NextRequest(`http://localhost/api/onboarding/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION as never);
});

describe("onboarding validation error contract", () => {
  it("pins disclaimer validation", async () => {
    const res = await disclaimerPost(req("disclaimer", {}));
    expect(res.status).toBe(422);
    expect((await res.json()).meta?.errorCode).toBe(
      "onboarding.disclaimer.invalid",
    );
  });

  it("pins tour validation", async () => {
    const res = await tourPost(req("tour", {}));
    expect(res.status).toBe(422);
    expect((await res.json()).meta?.errorCode).toBe("onboarding.tour.invalid");
  });

  it("pins legacy completion validation", async () => {
    const res = await completePost(req("complete", { heightCm: 20 }));
    expect(res.status).toBe(422);
    expect((await res.json()).meta?.errorCode).toBe(
      "onboarding.complete.invalid",
    );
  });
});
