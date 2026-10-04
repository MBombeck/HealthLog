/**
 * v1.4.16 phase B2 — write endpoint for the user's AI provider chain.
 *
 * The Settings → AI section drives reorder + enable/disable through a
 * single dropdown + arrow controls; the persisted shape lives in
 * `User.aiProviderChain` (Json), parsed back through
 * `parseProviderChain()` on every read so a malformed payload from a
 * stale client cannot poison the chain.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirror `apiHandler`'s real behaviour: an `HttpError` thrown from the
// inner handler is converted to a JSON envelope. The tests assert on
// `res.status`, so the wrapper must surface the correct status code.
vi.mock("@/lib/api-handler", () => {
  class HttpError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
      this.name = "HttpError";
    }
  }
  return {
    apiHandler:
      <T extends (...args: unknown[]) => unknown>(fn: T) =>
      async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (e) {
          if (e instanceof HttpError) {
            return new Response(
              JSON.stringify({ data: null, error: e.message }),
              {
                status: e.status,
                headers: { "content-type": "application/json" },
              },
            );
          }
          throw e;
        }
      },
    requireAuth: vi.fn(async () => ({
      user: { id: "u-1" },
      session: { id: "s-1" },
    })),
    HttpError,
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      update: vi.fn(),
      // #1126 — the stored chain, read for the reasoning settings it carries.
      findUnique: vi.fn(async () => null),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/ai/provider-runner", () => ({
  getLastWorkingProvider: vi.fn(),
  forgetLastWorkingProvider: vi.fn(),
}));

import { PUT } from "../route";
import { prisma } from "@/lib/db";
import { forgetLastWorkingProvider } from "@/lib/ai/provider-runner";
import { annotate } from "@/lib/logging/context";

interface Envelope {
  data?: { saved: true } | null;
  error?: string | null;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://t/test", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PUT /api/insights/provider-chain", () => {
  it("persists a valid chain to user.aiProviderChain", async () => {
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as never);

    const res = await (PUT as (req: Request) => Promise<Response>)(
      jsonRequest({
        chain: [
          { providerType: "openai", priority: 1, enabled: true },
          { providerType: "codex", priority: 2, enabled: false },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.data).toEqual({ saved: true });

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(prisma.user.update).mock.calls[0][0];
    expect(callArg.where).toEqual({ id: "u-1" });
    expect(callArg.data).toEqual({
      aiProviderChain: [
        { providerType: "openai", priority: 1, enabled: true },
        { providerType: "codex", priority: 2, enabled: false },
      ],
    });
    expect(annotate).toHaveBeenCalled();
    // The remembered working provider would reorder the chain the person
    // just arranged; a save drops it for this account.
    expect(forgetLastWorkingProvider).toHaveBeenCalledWith("u-1");
  });

  it("rejects unknown provider types with 422", async () => {
    const res = await (PUT as (req: Request) => Promise<Response>)(
      jsonRequest({
        chain: [{ providerType: "bogus", priority: 1, enabled: true }],
      }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an empty chain with 422", async () => {
    const res = await (PUT as (req: Request) => Promise<Response>)(
      jsonRequest({ chain: [] }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects duplicate provider types in the same chain with 422", async () => {
    const res = await (PUT as (req: Request) => Promise<Response>)(
      jsonRequest({
        chain: [
          { providerType: "openai", priority: 1, enabled: true },
          { providerType: "openai", priority: 2, enabled: true },
        ],
      }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("normalises priority to insertion order even when client supplies arbitrary numbers", async () => {
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as never);

    const res = await (PUT as (req: Request) => Promise<Response>)(
      jsonRequest({
        chain: [
          { providerType: "openai", priority: 99, enabled: true },
          { providerType: "codex", priority: 1, enabled: true },
        ],
      }),
    );
    expect(res.status).toBe(200);

    // The route MUST normalise priority to the wire order so the UI's
    // drag-arrow contract matches what gets persisted: "first row in the
    // list always has priority 1, second row priority 2, …".
    const callArg = vi.mocked(prisma.user.update).mock.calls[0][0];
    expect(callArg.data.aiProviderChain).toEqual([
      { providerType: "openai", priority: 1, enabled: true },
      { providerType: "codex", priority: 2, enabled: true },
    ]);
  });

  // #1126 — the reasoning setting rides on the local / openai-compatible
  // entries. The chain editor only reorders and toggles, so saving the order
  // must not wipe a value it never sent.
  describe("reasoning setting", () => {
    function storedChain(chain: unknown) {
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        aiProviderChain: chain,
      } as never);
    }
    async function put(chain: unknown[]) {
      vi.mocked(prisma.user.update).mockResolvedValueOnce({} as never);
      return (PUT as (req: Request) => Promise<Response>)(
        jsonRequest({ chain }),
      );
    }
    function persisted() {
      return vi.mocked(prisma.user.update).mock.calls[0][0].data
        .aiProviderChain;
    }

    it("persists a value sent on a local entry", async () => {
      storedChain(null);
      const res = await put([
        { providerType: "local", enabled: true, reasoningEffort: "none" },
        { providerType: "openai", enabled: true },
      ]);
      expect(res.status).toBe(200);
      expect(persisted()).toEqual([
        {
          providerType: "local",
          priority: 1,
          enabled: true,
          reasoningEffort: "none",
        },
        { providerType: "openai", priority: 2, enabled: true },
      ]);
    });

    it("keeps the stored value when the body leaves it out", async () => {
      storedChain([
        { providerType: "openai", priority: 1, enabled: true },
        {
          providerType: "openai-compatible",
          priority: 2,
          enabled: false,
          reasoningEffort: "high",
        },
      ]);
      await put([
        { providerType: "openai-compatible", enabled: true },
        { providerType: "openai", enabled: true },
      ]);
      expect(persisted()).toEqual([
        {
          providerType: "openai-compatible",
          priority: 1,
          enabled: true,
          reasoningEffort: "high",
        },
        { providerType: "openai", priority: 2, enabled: true },
      ]);
    });

    it("clears it on null", async () => {
      storedChain([
        {
          providerType: "local",
          priority: 1,
          enabled: true,
          reasoningEffort: "low",
        },
      ]);
      await put([
        { providerType: "local", enabled: true, reasoningEffort: null },
      ]);
      expect(persisted()).toEqual([
        { providerType: "local", priority: 1, enabled: true },
      ]);
    });

    it("refuses it on an entry that cannot carry it", async () => {
      const res = await put([
        { providerType: "anthropic", enabled: true, reasoningEffort: "none" },
      ]);
      expect(res.status).toBe(422);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
