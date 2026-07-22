import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as ApiHandlerModule from "@/lib/api-handler";

const { requireAuth, requireAssistantSurface, annotate, auditLog } = vi.hoisted(
  () => ({
    requireAuth: vi.fn(),
    requireAssistantSurface: vi.fn(),
    annotate: vi.fn(),
    auditLog: vi.fn(),
  }),
);

vi.mock("@/lib/api-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHandlerModule>();
  return {
    ...actual,
    apiHandler: <T extends (...args: never[]) => unknown>(handler: T) =>
      handler,
    requireAuth,
  };
});
vi.mock("@/lib/feature-flags", () => ({ requireAssistantSurface }));
vi.mock("@/lib/logging/context", () => ({ annotate }));
vi.mock("@/lib/auth/audit", () => ({ auditLog }));
vi.mock("@/lib/ai/coach/persistence", () => ({
  COACH_CONVERSATION_TITLE_MAX: 80,
  deleteConversation: vi.fn(),
  fetchConversationWithMessages: vi.fn(),
  renameConversation: vi.fn(),
}));

import { PATCH } from "../route";
import { renameConversation } from "@/lib/ai/coach/persistence";

const USER_ID = "user-1";
const CONVERSATION_ID = "conversation-1";

function request(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/insights/chat/${CONVERSATION_ID}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify(body),
    },
  );
}

function context(id = CONVERSATION_ID) {
  return { params: Promise.resolve({ id }) };
}

async function body(response: Response) {
  return response.json() as Promise<{
    data: unknown;
    error: string | null;
    meta?: { errorCode?: string };
  }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockResolvedValue({ user: { id: USER_ID, locale: "en" } });
  requireAssistantSurface.mockResolvedValue(undefined);
  auditLog.mockResolvedValue(undefined);
});

describe("PATCH /api/insights/chat/[id]", () => {
  it("requires authentication before reading or updating a conversation", async () => {
    const unauthenticated = new Error("Not authenticated");
    requireAuth.mockRejectedValue(unauthenticated);

    await expect(PATCH(request({ title: "Renamed" }), context())).rejects.toBe(
      unauthenticated,
    );
    expect(requireAssistantSurface).not.toHaveBeenCalled();
    expect(renameConversation).not.toHaveBeenCalled();
  });

  it("rejects empty, whitespace-only, over-80, and extra-field bodies with a stable code", async () => {
    for (const payload of [
      { title: "" },
      { title: "   " },
      { title: "x".repeat(81) },
      { title: "Valid", ownerId: "other-user" },
    ]) {
      const response = await PATCH(request(payload), context());
      expect(response.status).toBe(422);
      expect((await body(response)).meta?.errorCode).toBe(
        "coach.conversation.invalidTitle",
      );
    }
    expect(renameConversation).not.toHaveBeenCalled();
  });

  it("maps foreign and unknown ids to the same 404 envelope without an existence leak", async () => {
    vi.mocked(renameConversation).mockResolvedValue(null);

    const foreign = await PATCH(
      request({ title: "Renamed" }),
      context("foreign"),
    );
    const unknown = await PATCH(
      request({ title: "Renamed" }),
      context("unknown"),
    );

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await body(foreign)).toEqual(await body(unknown));
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("trims and updates an owned title, returns the standard envelope, and audits the rename", async () => {
    vi.mocked(renameConversation).mockResolvedValue({
      id: CONVERSATION_ID,
      title: "Renamed conversation",
    });

    const response = await PATCH(
      request({ title: "  Renamed conversation  " }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      data: { id: CONVERSATION_ID, title: "Renamed conversation" },
      error: null,
    });
    expect(renameConversation).toHaveBeenCalledWith(
      USER_ID,
      CONVERSATION_ID,
      "Renamed conversation",
    );
    expect(auditLog).toHaveBeenCalledWith(
      "coach.conversation.rename",
      expect.objectContaining({
        userId: USER_ID,
        details: { conversationId: CONVERSATION_ID },
      }),
    );
    expect(annotate).toHaveBeenCalledWith({
      action: {
        name: "insights.coach.rename",
        entity_type: "coach_conversation",
        entity_id: CONVERSATION_ID,
      },
    });
  });
});
