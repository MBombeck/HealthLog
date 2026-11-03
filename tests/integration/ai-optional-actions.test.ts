/**
 * AI actions refuse with the capability envelope, through the real handlers
 * and the real `apiHandler` against real Postgres.
 *
 * Each case asserts the exact status, `meta.errorCode`, `meta.capability`
 * and `meta.reason`, and that nothing downstream ran: no provider was asked
 * (the runner and the chain resolver are spies), no cached text was written.
 * The chat keeps its `coach.provider.none` SSE frame for a missing provider,
 * now carrying `reason`.
 *
 * Mutation check: removing `requireAiCapability("briefing")` from the
 * generate GET lets every state through to the cache read and turns all five
 * briefing cases red.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  enterState,
  makeUser,
  resetWorld,
  setSwitches,
  signIn,
  type StateName,
} from "./ai-optional-fixtures";
import { getPrismaClient } from "./setup";
import { sealInsightsCachedText } from "@/lib/insights/cached-text-cipher";

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

// Provider spies: a refusal must never reach either.
const runner = vi.hoisted(() => ({
  raw: vi.fn(),
  streaming: vi.fn(),
  chain: vi.fn(),
}));
vi.mock("@/lib/ai/provider-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/provider-runner")>()),
  runRawCompletionWithFallback: runner.raw,
  runStreamingRawCompletionWithFallback: runner.streaming,
}));
vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  return {
    ...actual,
    resolveProviderChain: (...args: unknown[]) => {
      runner.chain(...args);
      return actual.resolveProviderChain(
        ...(args as Parameters<typeof actual.resolveProviderChain>),
      );
    },
  };
});

interface Envelope {
  data: unknown;
  error: string | null;
  meta?: {
    errorCode?: string;
    capability?: string;
    reason?: string;
    module?: string;
  };
}

async function generateGet(): Promise<{ status: number; body: Envelope }> {
  const { GET } = await import("@/app/api/insights/generate/route");
  const res = await GET(
    new NextRequest("http://localhost/api/insights/generate"),
  );
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function generatePost(): Promise<{ status: number; body: Envelope }> {
  const { POST } = await import("@/app/api/insights/generate/route");
  const res = await POST(
    new NextRequest("http://localhost/api/insights/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function chatPost(): Promise<Response> {
  const { POST } = await import("@/app/api/insights/chat/route");
  return POST(
    new NextRequest("http://localhost/api/insights/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "How was my week?" }),
    }),
  );
}

async function cachedAt(userId: string): Promise<Date | null> {
  const row = await getPrismaClient().user.findUniqueOrThrow({
    where: { id: userId },
    select: { insightsCachedAt: true },
  });
  return row.insightsCachedAt;
}

beforeEach(async () => {
  await resetWorld();
  runner.raw.mockReset();
  runner.streaming.mockReset();
  runner.chain.mockReset();
});

const BRIEFING_REFUSALS: ReadonlyArray<
  [StateName, number, string, string, string | undefined]
> = [
  ["S1", 403, "assistant.disabled.briefing", "operator_disabled", undefined],
  ["S2", 403, "assistant.disabled.briefing", "operator_disabled", undefined],
  ["S3", 422, "ai.provider.none", "no_provider", undefined],
  ["S4", 403, "consent.ai.required", "consent_required", undefined],
  ["S6", 403, "module.disabled", "user_disabled", "insights"],
];

describe("insights/generate refuses by the briefing capability", () => {
  it.each(BRIEFING_REFUSALS)(
    "%s: GET and POST answer %i %s",
    async (state, status, errorCode, reason, module) => {
      const world = await enterState(state);
      const before = await cachedAt(world.recordId);
      for (const call of [generateGet, generatePost]) {
        const { status: got, body } = await call();
        expect(got, `${state} ${call.name}`).toBe(status);
        expect(body.data).toBeNull();
        expect(body.meta).toMatchObject({
          errorCode,
          capability: "briefing",
          reason,
          ...(module ? { module } : {}),
        });
      }
      expect(runner.raw).not.toHaveBeenCalled();
      expect(runner.chain).not.toHaveBeenCalled();
      expect(await cachedAt(world.recordId)).toEqual(before);
    },
  );

  it("hiding the Coach does not refuse the briefing (S5)", async () => {
    const world = await enterState("S5");
    const { encrypt } = await import("@/lib/crypto");
    await getPrismaClient().user.update({
      where: { id: world.recordId },
      data: {
        // The read resolves (never calls) the chain, so the key must decrypt.
        aiAnthropicKeyEncrypted: encrypt("sk-ant-integration"),
        insightsCachedTextEncrypted: sealInsightsCachedText(
          JSON.stringify({
            dailyBriefing: { paragraph: "Held text.", keyFindings: [] },
          }),
        ),
        insightsCachedAt: new Date(),
        insightsCachedLocale: "en",
      },
    });
    const { status } = await generateGet();
    expect(status).toBe(200);
  });
});

describe("insights/chat refuses by the coach capability", () => {
  it.each([
    ["S1", 403, "assistant.disabled.coach", "operator_disabled", undefined],
    ["S5", 403, "module.disabled", "user_disabled", "coach"],
    ["S4", 403, "consent.ai.required", "consent_required", undefined],
  ] as const)(
    "%s: POST answers %i %s before any stream opens",
    async (state, status, errorCode, reason, module) => {
      await enterState(state);
      const res = await chatPost();
      expect(res.status).toBe(status);
      const body = (await res.json()) as Envelope;
      expect(body.meta).toMatchObject({
        errorCode,
        capability: "coach",
        reason,
        ...(module ? { module } : {}),
      });
      expect(runner.raw).not.toHaveBeenCalled();
      expect(runner.streaming).not.toHaveBeenCalled();
      expect(runner.chain).not.toHaveBeenCalled();
      const conversations = await getPrismaClient().coachConversation.count();
      expect(conversations).toBe(0);
    },
  );

  it("S3: keeps the coach.provider.none frame, now with the reason", async () => {
    await enterState("S3");
    const res = await chatPost();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"code":"coach.provider.none"');
    expect(text).toContain('"reason":"no_provider"');
    expect(runner.chain).not.toHaveBeenCalled();
  });

  it("the Coach module off at the operator is the operator's switch", async () => {
    const user = await makeUser("operator-coach-off");
    await setSwitches({ assistantCoachEnabled: false });
    await signIn(user.id);
    const res = await chatPost();
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.meta?.errorCode).toBe("assistant.disabled.coach");
  });
});
