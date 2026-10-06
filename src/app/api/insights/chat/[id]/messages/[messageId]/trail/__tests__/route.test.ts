/**
 * v1.41 — the trail route: owner-narrowed, 404 for anything else, the
 * model-written text only while the Coach's text may be shown, and the
 * person's own facts (recalled, proposed) always, minus medication facts
 * while the medications module is off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as ApiHandlerModule from "@/lib/api-handler";

const {
  requireAuth,
  readMessageTrail,
  aiCapabilityToServe,
  isModuleEnabled,
  findMany,
} = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  readMessageTrail: vi.fn(),
  aiCapabilityToServe: vi.fn(),
  isModuleEnabled: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/api-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHandlerModule>();
  return {
    ...actual,
    apiHandler: <T extends (...args: never[]) => unknown>(handler: T) =>
      handler,
    requireAuth,
  };
});
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/ai/coach/persistence", () => ({ readMessageTrail }));
vi.mock("@/lib/ai/capabilities/gate", () => ({ aiCapabilityToServe }));
vi.mock("@/lib/modules/gate", () => ({ isModuleEnabled }));
vi.mock("@/lib/db", () => ({ prisma: { coachFact: { findMany } } }));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: (b: Uint8Array) => new TextDecoder().decode(b),
}));

import { GET } from "../route";

const USER_ID = "user-1";
const TRAIL = {
  entries: [
    {
      id: "a1",
      title: "Weighing the two weeks",
      text: "Looked at sleep first.",
    },
  ],
};

function call(id = "c1", messageId = "m1") {
  return GET(
    new NextRequest(
      `http://localhost/api/insights/chat/${id}/messages/${messageId}/trail`,
    ),
    { params: Promise.resolve({ id, messageId }) },
  ) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockResolvedValue({ user: { id: USER_ID } });
  aiCapabilityToServe.mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
  isModuleEnabled.mockResolvedValue(true);
  findMany.mockResolvedValue([]);
});

const UNAVAILABLE = {
  available: false,
  reason: "disabled_by_user",
  onDeviceAllowed: false,
};

const WITH_FACTS = {
  ...TRAIL,
  recalled: ["Prefers walks after dinner", "Takes Mounjaro since May"],
  proposal: {
    proposalId: "mp_1",
    category: "condition",
    fact: "Has asthma",
  },
};

describe("GET /api/insights/chat/[id]/messages/[messageId]/trail", () => {
  it("reads under the caller's own id and the path ids only", async () => {
    readMessageTrail.mockResolvedValue({ trail: TRAIL });
    const response = await call("c1", "m1");
    expect(response.status).toBe(200);
    expect(readMessageTrail).toHaveBeenCalledWith(USER_ID, "c1", "m1");
    // Requires a session or a full-access token, like every Coach read.
    expect(requireAuth).toHaveBeenCalledWith();
    const body = await response.json();
    expect(body.data.trail).toEqual(TRAIL);
    expect(body.data.ai.available).toBe(true);
  });

  it("answers 404 for a message the caller does not own", async () => {
    readMessageTrail.mockResolvedValue(null);
    const response = await call();
    expect(response.status).toBe(404);
    expect(aiCapabilityToServe).not.toHaveBeenCalled();
  });

  it("serves no model text while the Coach's text may not be shown", async () => {
    readMessageTrail.mockResolvedValue({ trail: TRAIL });
    aiCapabilityToServe.mockResolvedValue({
      available: false,
      reason: "disabled_by_user",
      onDeviceAllowed: false,
    });
    const response = await call();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.trail).toBeNull();
    expect(body.data.ai.available).toBe(false);
    expect(aiCapabilityToServe).toHaveBeenCalledWith(USER_ID, "coach");
  });

  it("serves the person's own facts while the model text is withheld", async () => {
    readMessageTrail.mockResolvedValue({ trail: WITH_FACTS });
    aiCapabilityToServe.mockResolvedValue(UNAVAILABLE);
    const body = await (await call()).json();
    expect(body.data.trail).toEqual({
      entries: [],
      recalled: WITH_FACTS.recalled,
      proposal: WITH_FACTS.proposal,
    });
    expect(body.data.ai.available).toBe(false);
  });

  it("withholds medication facts while the medications module is off", async () => {
    readMessageTrail.mockResolvedValue({
      trail: {
        ...WITH_FACTS,
        recalled: [...WITH_FACTS.recalled, "Morning pill with coffee"],
        proposal: {
          proposalId: "mp_1",
          category: "medication",
          fact: "Takes ramipril",
        },
      },
    });
    isModuleEnabled.mockResolvedValue(false);
    // A stored fact filed under medication whose words the lexicon misses.
    findMany.mockResolvedValue([
      { factEncrypted: new TextEncoder().encode("Morning pill with coffee") },
    ]);
    const body = await (await call()).json();
    expect(isModuleEnabled).toHaveBeenCalledWith(USER_ID, "medications");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, category: "medication" },
      }),
    );
    expect(body.data.trail).toEqual({
      entries: TRAIL.entries,
      recalled: ["Prefers walks after dinner"],
    });
  });

  it("answers a message without a trail with null", async () => {
    readMessageTrail.mockResolvedValue({ trail: null });
    const body = await (await call()).json();
    expect(body.data.trail).toBeNull();
  });
});
