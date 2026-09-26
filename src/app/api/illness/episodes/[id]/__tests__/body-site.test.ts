/**
 * v1.39.2 — a condition's body site and side on the episode write routes.
 *
 * The contract that matters most is the one a client in the field relies on
 * without knowing it: the shipped iPhone app edits conditions and has never
 * heard of either field. Its PATCH body (built by `IllnessEpisodePatch` in the
 * public iOS repository) always carries `resolvedAt`, `parentConditionId` and
 * `note`, sometimes `label`, and never `bodySite` or `laterality`. That body
 * must not touch either column, or every edit from the phone would erase what
 * the web client stored.
 *
 * Mutation checks (each run, each seen red):
 *   - write `data.bodySiteEncrypted = null` unconditionally in the PATCH →
 *     "an edit from the shipped iPhone app" goes red;
 *   - drop the `encryptToBytes` call in the POST (store the bytes of the plain
 *     string) → "stores the site as ciphertext" goes red.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

vi.mock("@/lib/db", () => ({
  prisma: {
    illnessEpisode: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/illness/gate", () => ({ requireIllnessEnabled: vi.fn() }));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserHealthContext: vi.fn(),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
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

import { PATCH } from "../route";
import { POST } from "../../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const PARAMS = { params: Promise.resolve({ id: "ep-1" }) };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "ep-1",
    userId: "user-1",
    label: "Meniscus tear",
    type: "INJURY",
    lifecycle: "ACUTE",
    onsetAt: new Date("2026-06-01T00:00:00.000Z"),
    resolvedAt: null,
    parentConditionId: null,
    noteEncrypted: null,
    bodySiteEncrypted: encryptToBytes("Knee"),
    laterality: "LEFT",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function patchReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/illness/episodes/ep-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/illness/episodes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The `data` the route handed to `illnessEpisode.update`. */
function updateData(): Record<string, unknown> {
  const call = vi.mocked(prisma.illnessEpisode.update).mock.calls.at(-1);
  return (call?.[0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireIllnessEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(prisma.illnessEpisode.findUnique).mockResolvedValue(row() as never);
  vi.mocked(prisma.illnessEpisode.update).mockImplementation((async () =>
    row()) as never);
});

describe("PATCH /api/illness/episodes/{id} — body site", () => {
  it("an edit from the shipped iPhone app leaves the site and side alone", async () => {
    // The exact shape `IllnessEpisodePatch.encode(to:)` emits for a label
    // change: optional scalars only when set, the three full-value keys always.
    const res = await PATCH(
      patchReq({
        label: "Meniscus tear, medial",
        resolvedAt: null,
        parentConditionId: null,
        note: "Physio twice a week",
      }),
      PARAMS as never,
    );
    expect(res.status).toBe(200);
    const data = updateData();
    expect(data.label).toBe("Meniscus tear, medial");
    expect("bodySiteEncrypted" in data).toBe(false);
    expect("laterality" in data).toBe(false);

    // And the answer still carries what was stored, so the phone's next read
    // and the web's next read agree.
    const body = await res.json();
    expect(body.data.bodySite).toBe("Knee");
    expect(body.data.laterality).toBe("LEFT");
  });

  it("writes the site encrypted and the side as sent", async () => {
    const res = await PATCH(
      patchReq({ bodySite: "  Lower back ", laterality: "BOTH" }),
      PARAMS as never,
    );
    expect(res.status).toBe(200);
    const data = updateData();
    expect(decryptFromBytes(data.bodySiteEncrypted as Uint8Array)).toBe(
      "Lower back",
    );
    expect(data.laterality).toBe("BOTH");
  });

  it("clears both on null, and a blank site clears the site", async () => {
    await PATCH(
      patchReq({ bodySite: null, laterality: null }),
      PARAMS as never,
    );
    expect(updateData()).toMatchObject({
      bodySiteEncrypted: null,
      laterality: null,
    });
    await PATCH(patchReq({ bodySite: "   " }), PARAMS as never);
    expect(updateData().bodySiteEncrypted).toBeNull();
  });

  it("refuses a side outside the three values", async () => {
    const res = await PATCH(patchReq({ laterality: "UP" }), PARAMS as never);
    expect(res.status).toBe(422);
    expect(prisma.illnessEpisode.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/illness/episodes — body site", () => {
  beforeEach(() => {
    vi.mocked(prisma.illnessEpisode.create).mockImplementation((async (args: {
      data: Record<string, unknown>;
    }) => row({ ...args.data, id: "ep-new" })) as never);
  });

  it("stores the site as ciphertext and returns it readable", async () => {
    const res = await POST(
      postReq({
        label: "Tennis elbow",
        type: "INJURY",
        bodySite: "Elbow",
        laterality: "RIGHT",
      }),
    );
    expect(res.status).toBe(201);
    const call = vi.mocked(prisma.illnessEpisode.create).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    const stored = call.data.bodySiteEncrypted as Uint8Array;
    expect(Buffer.from(stored).toString("utf8")).not.toContain("Elbow");
    expect(decryptFromBytes(stored)).toBe("Elbow");
    expect(call.data.laterality).toBe("RIGHT");
    const body = await res.json();
    expect(body.data).toMatchObject({ bodySite: "Elbow", laterality: "RIGHT" });
  });

  it("a create from the shipped iPhone app stores no site", async () => {
    // `IllnessEpisodeCreate` sends label + type and the set optionals only.
    const res = await POST(
      postReq({ label: "Cold", type: "INFECTION", lifecycle: "ACUTE" }),
    );
    expect(res.status).toBe(201);
    const call = vi.mocked(prisma.illnessEpisode.create).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.bodySiteEncrypted).toBeNull();
    expect(call.data.laterality).toBeNull();
  });
});
