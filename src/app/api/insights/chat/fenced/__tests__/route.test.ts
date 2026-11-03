import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.29.x (S7) — the fenced multi-document endpoint's ORCHESTRATION (design §3).
 * The turn pipeline itself is covered in fenced-chat-pipeline.test.ts; here we
 * pin: `.strict()` body smuggling (test 8), the attachmentIds+conversationId
 * conflict (test 8), all-or-nothing first-turn validation / IDOR (tests 10, 22,
 * 24), the fenced-only fetch for an existing thread (test 11), and refusal wiring.
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/ai/capabilities/gate", async () =>
  (
    await import("@/__tests__/helpers/provider-order-mock")
  ).openCapabilityGateMock(),
);
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn().mockResolvedValue("en"),
}));
vi.mock("@/lib/ai/coach/persistence", () => ({
  createConversation: vi.fn(),
  fetchConversationWithMessages: vi.fn(),
}));
vi.mock("@/lib/documents/attach-validate", () => ({
  validateAttachmentCandidate: vi.fn(),
}));
vi.mock("@/lib/documents/fenced-chat", () => ({
  loadFencedDocuments: vi.fn(),
  screenFencedInbound: vi.fn(() => ({ refuse: false })),
  streamFencedReply: vi.fn(async () => new Response("stream", { status: 200 })),
  streamFencedRefusal: vi.fn(
    async () => new Response("refusal", { status: 200 }),
  ),
}));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { getSession } from "@/lib/auth/session";
import { requireAiCapability } from "@/lib/ai/capabilities/gate";
import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";
import {
  createConversation,
  fetchConversationWithMessages,
} from "@/lib/ai/coach/persistence";
import { validateAttachmentCandidate } from "@/lib/documents/attach-validate";
import {
  loadFencedDocuments,
  screenFencedInbound,
  streamFencedReply,
  streamFencedRefusal,
} from "@/lib/documents/fenced-chat";

const SESSION_OK = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "t", role: "USER" as const, locale: "en" },
};

const req = (body: unknown) =>
  new NextRequest(new URL("http://localhost/api/insights/chat/fenced"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function errorCode(res: Response): Promise<string | undefined> {
  const body = await res.json();
  return body.meta?.errorCode ?? body.errorCode;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(screenFencedInbound).mockReturnValue({ refuse: false });
  vi.mocked(validateAttachmentCandidate).mockResolvedValue({ ok: true });
  vi.mocked(loadFencedDocuments).mockResolvedValue({
    ok: true,
    docs: [
      {
        documentId: "doc-a",
        title: "A",
        filename: null,
        text: "t",
        source: "verbatim",
      },
    ],
  } as never);
  vi.mocked(createConversation).mockResolvedValue({
    id: "conv-new",
    title: "t",
    createdAt: "",
    updatedAt: "",
    messageCount: 0,
    fenced: true,
    attachments: [],
  });
});

describe("fenced route — body smuggling (.strict)", () => {
  it.each(["scope", "guidedQuestion", "prefill", "userId"])(
    "422s a body carrying the tool-mode / userId field %s",
    async (field) => {
      const res = await POST(
        req({ message: "hi", attachmentIds: ["doc-a"], [field]: "x" }) as never,
      );
      expect(res.status).toBe(422);
      expect(streamFencedReply).not.toHaveBeenCalled();
    },
  );

  it("422s attachmentIds together with conversationId (one write path per concern)", async () => {
    const res = await POST(
      req({
        conversationId: "c1",
        message: "hi",
        attachmentIds: ["doc-a"],
      }) as never,
    );
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("coach.fenced.attachmentConflict");
    expect(createConversation).not.toHaveBeenCalled();
  });
});

describe("fenced route — first-turn create (all-or-nothing validation)", () => {
  it("creates a fenced conversation when every attachment validates", async () => {
    const res = await POST(
      req({ message: "summarise", attachmentIds: ["doc-a", "doc-b"] }) as never,
    );
    expect(res.status).toBe(200);
    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        documentScoped: true,
        attachmentIds: ["doc-a", "doc-b"],
      }),
    );
    expect(streamFencedReply).toHaveBeenCalled();
  });

  it("fails the WHOLE request and creates NOTHING when one attachment is foreign (IDOR)", async () => {
    vi.mocked(validateAttachmentCandidate)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        errorCode: "documents.inbound.notFound",
      });
    const res = await POST(
      req({ message: "x", attachmentIds: ["mine", "someone-elses"] }) as never,
    );
    expect(res.status).toBe(404);
    expect(createConversation).not.toHaveBeenCalled();
    expect(streamFencedReply).not.toHaveBeenCalled();
  });

  it("422s (attachmentLimit) when a candidate exceeds the cap", async () => {
    vi.mocked(validateAttachmentCandidate).mockResolvedValue({
      ok: false,
      status: 422,
      errorCode: "coach.fenced.attachmentLimit",
    });
    const res = await POST(
      req({ message: "x", attachmentIds: ["doc-a"] }) as never,
    );
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("coach.fenced.attachmentLimit");
  });

  it("422s (attachmentRequired) when a fresh conversation has no attachments", async () => {
    const res = await POST(req({ message: "x" }) as never);
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("coach.fenced.attachmentRequired");
  });
});

describe("fenced route — existing conversation", () => {
  it("fetches with documentScoped:true and 404s a non-fenced / foreign id", async () => {
    vi.mocked(fetchConversationWithMessages).mockResolvedValue(null);
    const res = await POST(
      req({ conversationId: "tool-or-foreign", message: "hi" }) as never,
    );
    expect(res.status).toBe(404);
    expect(fetchConversationWithMessages).toHaveBeenCalledWith(
      "user-1",
      "tool-or-foreign",
      { documentScoped: true },
    );
  });

  it("grounds a continued turn on ALL of the thread's live attachments", async () => {
    vi.mocked(fetchConversationWithMessages).mockResolvedValue({
      id: "conv-1",
      fenced: true,
      attachments: [
        { documentId: "doc-a", title: "A" },
        { documentId: "doc-b", title: "B" },
      ],
      attachmentCount: 2,
      messages: [{ role: "user", content: "earlier", id: "m", createdAt: "" }],
    } as never);
    await POST(req({ conversationId: "conv-1", message: "next" }) as never);
    expect(loadFencedDocuments).toHaveBeenCalledWith("user-1", [
      "doc-a",
      "doc-b",
    ]);
  });
});

describe("fenced route — send-time attachment unavailable", () => {
  it("422s naming the doc when an attachment cannot be loaded (never partial context)", async () => {
    vi.mocked(fetchConversationWithMessages).mockResolvedValue({
      id: "conv-1",
      fenced: true,
      attachments: [{ documentId: "doc-dead", title: null }],
      attachmentCount: 1,
      messages: [],
    } as never);
    vi.mocked(loadFencedDocuments).mockResolvedValue({
      ok: false,
      unavailableDocId: "doc-dead",
    } as never);
    const res = await POST(
      req({ conversationId: "conv-1", message: "hi" }) as never,
    );
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("coach.fenced.attachmentUnavailable");
    expect(streamFencedReply).not.toHaveBeenCalled();
  });
});

describe("fenced route — refusal", () => {
  it("streams a refusal (no provider) when the inbound message is injection-shaped", async () => {
    vi.mocked(screenFencedInbound).mockReturnValue({
      refuse: true,
      reason: "prompt_injection",
      refusalText: "no",
      replayTurnIndex: null,
    });
    const res = await POST(
      req({ message: "x", attachmentIds: ["doc-a"] }) as never,
    );
    expect(res.status).toBe(200);
    expect(streamFencedRefusal).toHaveBeenCalled();
    expect(streamFencedReply).not.toHaveBeenCalled();
  });
});

describe("fenced route — the coach and documentAi capabilities", () => {
  it("answers under both, leaving provider and consent to the pick", async () => {
    await POST(req({ message: "hi", attachmentIds: ["doc-a"] }) as never);
    expect(requireAiCapability).toHaveBeenCalledWith("coach", {
      pickDecides: true,
    });
    expect(requireAiCapability).toHaveBeenCalledWith("documentAi", {
      pickDecides: true,
    });
    // The turn re-checks the Coach for the picked provider too.
    expect(streamFencedReply).toHaveBeenCalledWith(
      expect.objectContaining({ alsoRequires: ["coach"] }),
    );
  });

  it("refuses with the Coach's code before any conversation is created", async () => {
    vi.mocked(requireAiCapability).mockRejectedValueOnce(
      new AiUnavailableError("coach", "operator_disabled"),
    );
    const res = await POST(
      req({ message: "hi", attachmentIds: ["doc-a"] }) as never,
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("assistant.disabled.coach");
    expect(createConversation).not.toHaveBeenCalled();
    expect(streamFencedReply).not.toHaveBeenCalled();
  });

  it("refuses when document reading is off even with the Coach on", async () => {
    vi.mocked(requireAiCapability)
      .mockResolvedValueOnce({
        available: true,
        reason: null,
        onDeviceAllowed: true,
      })
      .mockRejectedValueOnce(
        new AiUnavailableError("documentAi", "operator_disabled"),
      );
    const res = await POST(
      req({ message: "hi", attachmentIds: ["doc-a"] }) as never,
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("assistant.disabled.documentAi");
    expect(streamFencedReply).not.toHaveBeenCalled();
  });
});
