import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.29.x (S7) — attach / detach routes (design §4.2, adversarial tests 9, 11,
 * 22 + the tool→fenced flip audit + the detach-writes-no-flag invariant).
 */

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  MODULE_DISABLED_ERROR_CODE: "module.disabled",
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/ai/coach/persistence", () => ({
  fetchConversationAttachmentState: vi.fn(),
  attachDocument: vi.fn().mockResolvedValue(undefined),
  detachDocument: vi.fn(),
  loadConversationAttachmentDTOs: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/documents/attach-validate", () => ({
  validateAttachmentCandidate: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/ai/capabilities/gate", async () =>
  (
    await import("@/__tests__/helpers/provider-order-mock")
  ).openCapabilityGateMock(),
);
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { DELETE } from "../[documentId]/route";
import { getSession } from "@/lib/auth/session";
import { requireAiCapability } from "@/lib/ai/capabilities/gate";
import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";
import {
  attachDocument,
  detachDocument,
  fetchConversationAttachmentState,
} from "@/lib/ai/coach/persistence";
import { validateAttachmentCandidate } from "@/lib/documents/attach-validate";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "t", role: "USER" as const, locale: "en" },
};

const postReq = (body: unknown) =>
  new NextRequest(
    new URL("http://localhost/api/insights/chat/conv-1/attachments"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
const postCtx = (id = "conv-1") => ({ params: Promise.resolve({ id }) });
const delCtx = (id = "conv-1", documentId = "doc-a") => ({
  params: Promise.resolve({ id, documentId }),
});

async function code(res: Response): Promise<string | undefined> {
  const b = await res.json();
  return b.meta?.errorCode ?? b.errorCode;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(validateAttachmentCandidate).mockResolvedValue({ ok: true });
});

describe("POST attach", () => {
  it("404s a foreign / unknown conversation (no cross-user leak)", async () => {
    vi.mocked(fetchConversationAttachmentState).mockResolvedValue(null);
    const res = await POST(
      postReq({ documentId: "doc-a" }) as never,
      postCtx() as never,
    );
    expect(res.status).toBe(404);
    expect(attachDocument).not.toHaveBeenCalled();
  });

  it("rejects the tool-mode/unknown body field via .strict()", async () => {
    vi.mocked(fetchConversationAttachmentState).mockResolvedValue({
      id: "conv-1",
      documentScoped: true,
      messageCount: 0,
      attachmentIds: [],
    });
    const res = await POST(
      postReq({ documentId: "doc-a", scope: "x" }) as never,
      postCtx() as never,
    );
    expect(res.status).toBe(422);
  });

  it("is idempotent for an already-attached document (200, no re-validate)", async () => {
    vi.mocked(fetchConversationAttachmentState).mockResolvedValue({
      id: "conv-1",
      documentScoped: true,
      messageCount: 3,
      attachmentIds: ["doc-a"],
    });
    const res = await POST(
      postReq({ documentId: "doc-a" }) as never,
      postCtx() as never,
    );
    expect(res.status).toBe(200);
    expect(validateAttachmentCandidate).not.toHaveBeenCalled();
    expect(attachDocument).not.toHaveBeenCalled();
  });

  it("422s (cap) when the candidate is rejected by validation", async () => {
    vi.mocked(fetchConversationAttachmentState).mockResolvedValue({
      id: "conv-1",
      documentScoped: true,
      messageCount: 0,
      attachmentIds: ["a", "b", "c", "d", "e"],
    });
    vi.mocked(validateAttachmentCandidate).mockResolvedValue({
      ok: false,
      status: 422,
      errorCode: "coach.fenced.attachmentLimit",
    });
    const res = await POST(
      postReq({ documentId: "doc-f" }) as never,
      postCtx() as never,
    );
    expect(res.status).toBe(422);
    expect(await code(res)).toBe("coach.fenced.attachmentLimit");
  });

  it("attaches to a fenced thread WITHOUT a conversion audit (already fenced)", async () => {
    vi.mocked(fetchConversationAttachmentState).mockResolvedValue({
      id: "conv-1",
      documentScoped: true,
      messageCount: 2,
      attachmentIds: ["doc-x"],
    });
    const res = await POST(
      postReq({ documentId: "doc-a" }) as never,
      postCtx() as never,
    );
    expect(res.status).toBe(200);
    expect(attachDocument).toHaveBeenCalledWith({
      conversationId: "conv-1",
      documentId: "doc-a",
    });
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("audits the tool→fenced flip when attaching to a NON-fenced thread with prior messages", async () => {
    vi.mocked(fetchConversationAttachmentState).mockResolvedValue({
      id: "conv-1",
      documentScoped: false,
      messageCount: 4,
      attachmentIds: [],
    });
    const res = await POST(
      postReq({ documentId: "doc-a" }) as never,
      postCtx() as never,
    );
    expect(res.status).toBe(200);
    expect(attachDocument).toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      "coach.attachments.converted",
      expect.objectContaining({
        userId: "user-1",
        details: { conversationId: "conv-1", priorMessages: 4 },
      }),
    );
  });
});

describe("DELETE detach", () => {
  it("404s a missing row / foreign conversation", async () => {
    vi.mocked(detachDocument).mockResolvedValue(false);
    const res = await DELETE(
      new NextRequest(
        new URL("http://localhost/api/insights/chat/conv-1/attachments/doc-a"),
        { method: "DELETE" },
      ) as never,
      delCtx() as never,
    );
    expect(res.status).toBe(404);
  });

  it("detaches and reports the conversation still FENCED (flag never cleared)", async () => {
    vi.mocked(detachDocument).mockResolvedValue(true);
    const res = await DELETE(
      new NextRequest(
        new URL("http://localhost/api/insights/chat/conv-1/attachments/doc-a"),
        { method: "DELETE" },
      ) as never,
      delCtx() as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.fenced).toBe(true);
  });
});

describe("attachments — the coach and documentAi capabilities", () => {
  it("refuses an attach when the Coach is off for the record", async () => {
    vi.mocked(requireAiCapability).mockRejectedValueOnce(
      new AiUnavailableError("coach", "user_disabled", "coach"),
    );
    const res = await POST(
      postReq({ documentId: "doc-a" }) as never,
      postCtx() as never,
    );
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("module.disabled");
    expect(attachDocument).not.toHaveBeenCalled();
  });

  it("checks both capabilities on attach", async () => {
    vi.mocked(fetchConversationAttachmentState).mockResolvedValue(null);
    await POST(postReq({ documentId: "doc-a" }) as never, postCtx() as never);
    expect(requireAiCapability).toHaveBeenCalledWith("coach", {
      pickDecides: true,
    });
    expect(requireAiCapability).toHaveBeenCalledWith("documentAi", {
      pickDecides: true,
    });
  });

  it("lets a detach through with every capability closed: it removes the person's own data", async () => {
    vi.mocked(requireAiCapability).mockRejectedValue(
      new AiUnavailableError("coach", "operator_disabled"),
    );
    vi.mocked(fetchConversationAttachmentState).mockResolvedValue({
      id: "conv-1",
      documentScoped: true,
      messageCount: 0,
      attachmentIds: ["doc-a"],
    });
    const res = await DELETE(
      new NextRequest(
        new URL("http://localhost/api/insights/chat/conv-1/attachments/doc-a"),
        { method: "DELETE" },
      ) as never,
      delCtx() as never,
    );
    expect(res.status).not.toBe(403);
    expect(requireAiCapability).not.toHaveBeenCalled();
  });
});
