/**
 * v1.4.16 — integration coverage for POST /api/insights/feedback.
 *
 * Three scenarios pinned end-to-end against the postgres testcontainer:
 *   1. POST a valid payload → 201, row persisted with server-filled
 *      providerType (from the latest insights.generate audit row) +
 *      promptVersion (from the PROMPT_VERSION constant). Audit log
 *      entry written with action `insights.recommendation.feedback`.
 *   2. Re-POST the same (recId, recText) → 409, no second row written.
 *   3. Validation failure (bad severity) → 422, no row written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";

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

async function seedUserWithAuditedGeneration(): Promise<{
  userId: string;
}> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "feedback-user",
      email: "feedback@example.test",
      role: "USER",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);

  // Seed a recent insights.generate audit row so the feedback endpoint
  // can pull `chainProviderType` from it for provider attribution.
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "insights.generate",
      details: JSON.stringify({
        privacyMode: "aggregated",
        providerType: "openai",
        chainProviderType: "codex",
        fallbackHopCount: 0,
        tokensUsed: 1234,
        model: "gpt-4o-mini",
      }),
    },
  });

  return { userId: user.id };
}

const baseBody = {
  recommendationId: "rec-1",
  recommendationText: "Discuss home BP log with your physician.",
  recommendationSeverity: "important",
  metricSourceType: "bloodPressure",
  metricSourceTimeRange: "last7days",
  helpful: true,
};

interface FeedbackEnvelope {
  data: { id: string; createdAt: string } | null;
  error?: string | null;
}

describe("POST /api/insights/feedback — integration", () => {
  it("persists a valid feedback row with server-filled provider attribution", async () => {
    const { userId } = await seedUserWithAuditedGeneration();
    const { POST } = await import("@/app/api/insights/feedback/route");

    const res = await (POST as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(baseBody),
      }),
    );
    expect(res.status).toBe(201);
    const env = (await res.json()) as FeedbackEnvelope;
    expect(env.data?.id).toBeTruthy();

    const prisma = getPrismaClient();
    const rows = await prisma.recommendationFeedback.findMany({
      where: { userId },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.recommendationId).toBe(baseBody.recommendationId);
    expect(row.recommendationText).toBe(baseBody.recommendationText);
    expect(row.recommendationSeverity).toBe(baseBody.recommendationSeverity);
    expect(row.metricSourceType).toBe(baseBody.metricSourceType);
    expect(row.metricSourceTimeRange).toBe(baseBody.metricSourceTimeRange);
    expect(row.helpful).toBe(true);
    // Server fills providerType + promptVersion — the body never
    // supplied them.
    expect(row.providerType).toBe("codex");
    expect(row.promptVersion).toBe(PROMPT_VERSION);

    // Audit row was written with the right action.
    const audit = await prisma.auditLog.findFirst({
      where: { userId, action: "insights.recommendation.feedback" },
    });
    expect(audit).not.toBeNull();
  });

  it("rejects a duplicate (recId, recText) with 409", async () => {
    const { userId } = await seedUserWithAuditedGeneration();
    const { POST } = await import("@/app/api/insights/feedback/route");

    const first = await (POST as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(baseBody),
      }),
    );
    expect(first.status).toBe(201);

    const second = await (POST as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(baseBody),
      }),
    );
    expect(second.status).toBe(409);

    const prisma = getPrismaClient();
    expect(
      await prisma.recommendationFeedback.count({ where: { userId } }),
    ).toBe(1);
  });

  it("rejects a bad severity with 422 and writes no row", async () => {
    const { userId } = await seedUserWithAuditedGeneration();
    const { POST } = await import("@/app/api/insights/feedback/route");

    const res = await (POST as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...baseBody, recommendationSeverity: "wat" }),
      }),
    );
    expect(res.status).toBe(422);

    const prisma = getPrismaClient();
    expect(
      await prisma.recommendationFeedback.count({ where: { userId } }),
    ).toBe(0);
  });

  it("falls back to providerType=unknown when no insights.generate audit row exists", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "fallback-user",
        email: "fallback-feedback@example.test",
        role: "USER",
      },
    });
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    cookieJar.set("healthlog_session", session.id);

    const { POST } = await import("@/app/api/insights/feedback/route");
    const res = await (POST as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(baseBody),
      }),
    );
    expect(res.status).toBe(201);

    const row = await prisma.recommendationFeedback.findFirst({
      where: { userId: user.id },
    });
    expect(row?.providerType).toBe("unknown");
    expect(row?.promptVersion).toBe(PROMPT_VERSION);
  });
});
