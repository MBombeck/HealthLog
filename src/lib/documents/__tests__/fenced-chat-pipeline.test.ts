import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v1.29.x (S7) — the shared fenced turn pipeline (design §3, adversarial tests
 * 12, 14, 16, 17, 18, 19). Pins: the capability re-check at the wire (the
 * document pick answers `documentAi`, each extra capability the entry point
 * names is asked for the same provider; any refusal means zero egress and no
 * user turn persisted), the SINGLE checked provider (no cascade), numeric grounding over the LIVE
 * attachment UNION, and the owner-scoped context loader (a corrupted/foreign join
 * row yields null → the turn refuses, never foreign text).
 */

const findFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { findFirst: (...a: unknown[]) => findFirst(...a) },
  },
}));
vi.mock("@/lib/documents/content-index", () => ({
  loadDocumentChatText: vi.fn(),
}));
vi.mock("@/lib/documents/provider-order", () => ({
  resolveDocumentTextProvider: vi.fn(),
}));
vi.mock("@/lib/ai/capabilities/egress", () => ({
  assertAiEgress: vi.fn(),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-07-16"),
  reserveBudget: vi.fn().mockResolvedValue({ allowed: true, reserved: 600 }),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 100000),
  resolveDailyCapFor: vi.fn(() => 100000),
  resolveCostOwner: vi.fn(() => "operator" as const),
}));
vi.mock("@/lib/ai/provider-runner", () => ({
  runStreamingRawCompletionWithFallback: vi.fn(),
  AllProvidersFailedError: class extends Error {},
}));
vi.mock("@/lib/ai/coach/persistence", () => ({ appendMessage: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

import {
  loadFencedDocuments,
  streamFencedReply,
  type FencedDocContext,
} from "../fenced-chat";
import { loadDocumentChatText } from "@/lib/documents/content-index";
import { resolveDocumentTextProvider } from "@/lib/documents/provider-order";
import { assertAiEgress } from "@/lib/ai/capabilities/egress";
import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";
import { runStreamingRawCompletionWithFallback } from "@/lib/ai/provider-runner";
import { appendMessage } from "@/lib/ai/coach/persistence";

const PICK = {
  chain: [{ providerType: "anthropic", instance: {} }],
  pick: {
    entry: { providerType: "anthropic", instance: {} },
    providerType: "anthropic",
  },
};

function doc(id: string, text: string): FencedDocContext {
  return {
    documentId: id,
    title: id,
    filename: null,
    text,
    source: "verbatim",
  };
}

async function drain(
  res: Response,
): Promise<{ type: string; token?: string }[]> {
  const raw = await res.text();
  return raw
    .split("\n\n")
    .map((c) => c.replace(/^data: /, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith(":"))
    .map((l) => JSON.parse(l));
}

const baseArgs = {
  userId: "user-1",
  conversationId: "conv-1",
  priorTurns: [],
  message: "hi",
  contractLocale: "en" as const,
  locale: "en" as const,
  signal: new AbortController().signal,
  alsoRequires: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveDocumentTextProvider).mockResolvedValue(PICK as never);
  vi.mocked(assertAiEgress).mockResolvedValue(undefined);
  vi.mocked(appendMessage).mockImplementation(
    async (p) => ({ id: p.role === "assistant" ? "a" : "u", ...p }) as never,
  );
  vi.mocked(runStreamingRawCompletionWithFallback).mockResolvedValue({
    result: { content: "ok", tokensUsed: 10, model: "m" },
    workingProvider: { providerType: "anthropic" },
    fallbackHops: [],
    tokensSpent: 0,
  } as never);
});

describe("streamFencedReply — the capability at the wire", () => {
  it("throws the document pick's refusal with ZERO egress and no user turn persisted", async () => {
    const refusal = new AiUnavailableError("documentAi", "consent_required");
    vi.mocked(resolveDocumentTextProvider).mockResolvedValue({
      chain: [],
      pick: null,
      withheld: refusal,
    } as never);
    await expect(
      streamFencedReply({ ...baseArgs, docs: [doc("a", "x"), doc("b", "y")] }),
    ).rejects.toBe(refusal);
    expect(runStreamingRawCompletionWithFallback).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("asks every extra capability about the picked provider", async () => {
    await drain(
      await streamFencedReply({
        ...baseArgs,
        alsoRequires: ["coach"],
        docs: [doc("a", "x"), doc("b", "y")],
      }),
    );
    expect(assertAiEgress).toHaveBeenCalledTimes(1);
    expect(assertAiEgress).toHaveBeenCalledWith("coach", "user-1", [
      "anthropic",
    ]);
  });

  it("refuses with ZERO egress when an extra capability closed", async () => {
    vi.mocked(assertAiEgress).mockRejectedValueOnce(
      new AiUnavailableError("coach", "operator_disabled"),
    );
    await expect(
      streamFencedReply({
        ...baseArgs,
        alsoRequires: ["coach"],
        docs: [doc("a", "x")],
      }),
    ).rejects.toBeInstanceOf(AiUnavailableError);
    expect(runStreamingRawCompletionWithFallback).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("keeps a missing provider an SSE frame, not a refusal", async () => {
    vi.mocked(resolveDocumentTextProvider).mockResolvedValue({
      chain: [],
      pick: null,
      withheld: null,
    } as never);
    const events = await drain(
      await streamFencedReply({ ...baseArgs, docs: [doc("a", "x")] }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ code: "documents.chat.provider.none" }),
    );
  });
});

describe("streamFencedReply — single provider, no cascade", () => {
  it("passes exactly the ONE checked provider entry to the runner", async () => {
    await drain(
      await streamFencedReply({ ...baseArgs, docs: [doc("a", "x")] }),
    );
    const call = vi.mocked(runStreamingRawCompletionWithFallback).mock
      .calls[0][0];
    expect((call as { providers: unknown[] }).providers).toHaveLength(1);
    expect(
      (call as { providers: { providerType: string }[] }).providers[0],
    ).toMatchObject({
      providerType: "anthropic",
    });
  });
});

describe("streamFencedReply — numeric grounding over the UNION", () => {
  it("retains a number present in one attached doc; strips a number in NONE", async () => {
    vi.mocked(runStreamingRawCompletionWithFallback).mockResolvedValue({
      result: {
        content: "Document B lists 55 and the total is 999.",
        tokensUsed: 10,
        model: "m",
      },
      workingProvider: { providerType: "anthropic" },
      fallbackHops: [],
      tokensSpent: 0,
    } as never);
    const res = await streamFencedReply({
      ...baseArgs,
      docs: [doc("a", "reading 160 mg/dL"), doc("b", "level 55 units")],
    });
    const reply = (await drain(res))
      .filter((e) => e.type === "token")
      .map((e) => e.token)
      .join("");
    // 55 is present in doc B (union) → retained; 999 is in no doc → stripped.
    expect(reply).toContain("55");
    expect(reply).not.toContain("999");
    const assistant = vi
      .mocked(appendMessage)
      .mock.calls.find((c) => c[0].role === "assistant");
    expect(assistant?.[0].content).not.toContain("999");
  });
});

describe("loadFencedDocuments — owner-scoped, fail-closed", () => {
  it("returns the docs when every id is owned + indexed", async () => {
    findFirst.mockResolvedValue({ title: "T", filename: "f.pdf" });
    vi.mocked(loadDocumentChatText).mockResolvedValue({
      text: "body",
      source: "verbatim",
    });
    const out = await loadFencedDocuments("user-1", ["doc-a"]);
    expect(out.ok).toBe(true);
    if (out.ok)
      expect(out.docs[0]).toMatchObject({ documentId: "doc-a", text: "body" });
    // The liveness/label query is owner-scoped + soft-delete-filtered.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "doc-a", userId: "user-1", deletedAt: null },
      }),
    );
  });

  it("fails closed (unavailableDocId) when a corrupted/foreign join row's text loader returns null", async () => {
    findFirst.mockResolvedValue({ title: "T", filename: null });
    vi.mocked(loadDocumentChatText).mockResolvedValue(null); // owner-scoped miss
    const out = await loadFencedDocuments("user-1", ["doc-a", "foreign"]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.unavailableDocId).toBe("doc-a");
  });

  it("fails closed when the document is soft-deleted / not owned (meta miss)", async () => {
    findFirst.mockResolvedValue(null);
    const out = await loadFencedDocuments("user-1", ["gone"]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.unavailableDocId).toBe("gone");
  });
});
