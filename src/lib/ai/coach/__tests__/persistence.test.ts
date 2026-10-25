import { describe, expect, it, vi } from "vitest";

// Mock the db + crypto boundaries so `recordProactiveNudge` can be
// exercised without a real Postgres / encryption key. The transaction
// runner simply invokes the callback with the stubbed `tx`.
const txCreate = {
  coachConversation: { create: vi.fn(), update: vi.fn() },
  coachMessage: { create: vi.fn() },
};
vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: vi.fn(async (cb: (tx: typeof txCreate) => Promise<unknown>) =>
      cb(txCreate),
    ),
  },
}));
vi.mock("../bytes-codec", () => ({
  encryptToBytes: vi.fn((text: string) =>
    new TextEncoder().encode(`enc:${text}`),
  ),
  decryptFromBytes: vi.fn(),
}));

import {
  appendMessage,
  recordProactiveNudge,
  summariseTitle,
} from "../persistence";
import { encryptToBytes } from "../bytes-codec";
import { MAX_TURN_STEPS } from "../activity/contract";
import type { CoachProvenance, CoachStep } from "../types";

describe("summariseTitle", () => {
  it("returns the input unchanged when below 80 chars", () => {
    const out = summariseTitle("Why is my BP higher this week?");
    expect(out).toBe("Why is my BP higher this week?");
  });

  it("collapses runs of whitespace", () => {
    const out = summariseTitle("Why    is\n\tmy BP\thigher?");
    expect(out).toBe("Why is my BP higher?");
  });

  it("trims leading and trailing whitespace", () => {
    const out = summariseTitle("   plenty of room   ");
    expect(out).toBe("plenty of room");
  });

  it("appends ellipsis when input is over 80 chars", () => {
    const long =
      "Could you walk me through the relationship between my morning blood pressure spikes and the late evening medication doses I took last week, including any noticeable patterns?";
    const out = summariseTitle(long);
    expect(out.endsWith("…")).toBe(true);
    // Visible width capped to 80
    expect([...out].length).toBeLessThanOrEqual(80);
  });

  it("cuts at a word boundary when one is within reach", () => {
    const long =
      "Walk me through the morning blood pressure trend I have been tracking since the last visit at the clinic in Hamburg this past month";
    const out = summariseTitle(long);
    // No trailing whitespace before the ellipsis
    expect(out).not.toMatch(/\s+…$/);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to a default title for empty input", () => {
    expect(summariseTitle("")).toBe("New conversation");
    expect(summariseTitle("    ")).toBe("New conversation");
  });
});

describe("recordProactiveNudge", () => {
  it("creates a conversation + an encrypted ASSISTANT message in one transaction", async () => {
    const now = new Date("2026-06-18T05:15:00.000Z");
    txCreate.coachConversation.create.mockResolvedValue({
      id: "conv_1",
      userId: "user_1",
      title: "Time to weigh in",
      createdAt: now,
      updatedAt: now,
    });
    txCreate.coachMessage.create.mockResolvedValue({
      id: "msg_1",
      createdAt: now,
    });

    const out = await recordProactiveNudge({
      userId: "user_1",
      title: "Time to weigh in",
      body: "It has been a week — a quick weigh-in keeps the trend honest.",
    });

    expect(out).toEqual({
      conversationId: "conv_1",
      messageId: "msg_1",
      createdAt: now,
    });

    // Conversation owned by the user, title summarised and stored as
    // ciphertext only (v1.39.3); the readable column is never written.
    const convArg = txCreate.coachConversation.create.mock.calls[0][0];
    expect(convArg.data.userId).toBe("user_1");
    expect(convArg.data).not.toHaveProperty("title");
    expect(new TextDecoder().decode(convArg.data.titleEncrypted)).toBe(
      "enc:Time to weigh in",
    );

    // The body is encrypted at rest (Bytes), role is assistant, and the
    // message hangs off the new conversation. No raw plaintext column.
    const msgArg = txCreate.coachMessage.create.mock.calls[0][0];
    expect(msgArg.data.conversationId).toBe("conv_1");
    expect(msgArg.data.role).toBe("assistant");
    expect(msgArg.data.providerType).toBe("nudge");
    expect(encryptToBytes).toHaveBeenCalledWith(
      "It has been a week — a quick weigh-in keeps the trend honest.",
    );
    // The stored column is the ciphertext, never the plaintext body.
    expect(new TextDecoder().decode(msgArg.data.encryptedContent)).toContain(
      "enc:",
    );
  });
});

describe("appendMessage — provenance round-trip", () => {
  // Echo the serialised metricSourceJson the write path produced, so the read
  // path (`provenanceFromJson`) round-trips it exactly as a reload would.
  function stubEchoCreate(overrideJson?: string | null): void {
    txCreate.coachConversation.update.mockResolvedValue({});
    txCreate.coachMessage.create.mockImplementation(
      async (arg: {
        data: {
          metricSourceJson: string | null;
          providerType: string | null;
          promptVersion: string | null;
          tokensUsed: number | null;
          model: string | null;
        };
      }) => ({
        id: "m_rt",
        createdAt: new Date("2026-07-24T00:00:00.000Z"),
        metricSourceJson:
          overrideJson !== undefined ? overrideJson : arg.data.metricSourceJson,
        providerType: arg.data.providerType,
        promptVersion: arg.data.promptVersion,
        tokensUsed: arg.data.tokensUsed,
        model: arg.data.model,
      }),
    );
  }

  it("restores the FULL envelope on reload — including suggestion, suggestedAction and toolCalls (v1.32.14 reload fix)", async () => {
    stubEchoCreate();
    const envelope: CoachProvenance = {
      windows: ["last30days"],
      metrics: ["bp"],
      counts: { bp: 12 },
      keyValues: [{ label: "Systolic", value: "128", unit: "mmHg" }],
      groundedFigures: [128],
      suggestion: {
        cadenceId: "bp-weekly",
        measurementType: "bp",
        label: "coach.suggest.bp",
      },
      suggestedAction: {
        actionType: "reminder.note",
        summary: "Recheck your evening reading",
        titleKey: "coach.suggestedAction.reminder.note",
        params: {
          actionType: "reminder.note",
          note: "Recheck BP in the evening",
          when: "evening",
          metric: "bp",
        },
      },
      toolCalls: [{ name: "get_metric_series", present: true }],
      unverifiedFigures: 2,
    };

    const out = await appendMessage({
      conversationId: "conv_1",
      role: "assistant",
      content: "Your systolic averaged 128.",
      metricSource: envelope,
    });

    // Before the fix, suggestion/suggestedAction/toolCalls were dropped here.
    expect(out.metricSource).toEqual(envelope);
  });

  it("round-trips a checkup.create action card", async () => {
    stubEchoCreate();
    const envelope: CoachProvenance = {
      windows: [],
      metrics: [],
      suggestedAction: {
        actionType: "checkup.create",
        summary: "Book a yearly check-up",
        titleKey: "coach.suggestedAction.checkup.create",
        params: {
          actionType: "checkup.create",
          label: "Annual physical",
          interval: "yearly",
        },
      },
    };
    const out = await appendMessage({
      conversationId: "conv_1",
      role: "assistant",
      content: "Consider a yearly check-up.",
      metricSource: envelope,
    });
    expect(out.metricSource).toEqual(envelope);
  });

  it("restores every step the turn may record, and none past the cap", async () => {
    const step = (n: number): CoachStep => ({
      id: `s${n}`,
      tool: "get_metric_series",
      labelKey: "coach.step.readWindow",
      label: "Read the series",
      domain: "bp",
      window: "last30days",
      status: "done",
      count: n,
    });
    const recorded = Array.from({ length: MAX_TURN_STEPS }, (_, i) =>
      step(i + 1),
    );
    stubEchoCreate();
    const full = await appendMessage({
      conversationId: "conv_1",
      role: "assistant",
      content: "A long answer.",
      metricSource: { windows: [], metrics: [], steps: recorded },
    });
    expect(full.metricSource?.steps).toEqual(recorded);

    // A stored blob longer than the cap is cut at the cap, not before it.
    stubEchoCreate(
      JSON.stringify({
        windows: [],
        metrics: [],
        steps: [...recorded, step(MAX_TURN_STEPS + 1)],
      }),
    );
    const over = await appendMessage({
      conversationId: "conv_1",
      role: "assistant",
      content: "An over-long blob.",
      metricSource: { windows: [], metrics: [] },
    });
    expect(over.metricSource?.steps).toEqual(recorded);
  });

  it("tolerates a legacy blob without the new fields (no throw, fields absent)", async () => {
    // A pre-feature row: only the original windows/metrics envelope on disk.
    stubEchoCreate(
      JSON.stringify({ windows: ["last7days"], metrics: ["sleep"] }),
    );
    const out = await appendMessage({
      conversationId: "conv_1",
      role: "assistant",
      content: "old row",
      metricSource: { windows: [], metrics: [] },
    });
    expect(out.metricSource).toEqual({
      windows: ["last7days"],
      metrics: ["sleep"],
    });
    expect(out.metricSource?.unverifiedFigures).toBeUndefined();
    expect(out.metricSource?.suggestion).toBeUndefined();
  });

  it("drops a malformed unverifiedFigures / suggestedAction rather than trusting it", async () => {
    stubEchoCreate(
      JSON.stringify({
        windows: [],
        metrics: [],
        unverifiedFigures: -3, // negative → dropped
        suggestion: { cadenceId: 42 }, // wrong type → dropped
        suggestedAction: { actionType: "medication.create" }, // off-allowlist → dropped
        toolCalls: [{ name: "ok", present: "yes" }], // present not boolean → dropped
      }),
    );
    const out = await appendMessage({
      conversationId: "conv_1",
      role: "assistant",
      content: "malformed",
      metricSource: { windows: [], metrics: [] },
    });
    expect(out.metricSource?.unverifiedFigures).toBeUndefined();
    expect(out.metricSource?.suggestion).toBeUndefined();
    expect(out.metricSource?.suggestedAction).toBeUndefined();
    expect(out.metricSource?.toolCalls).toBeUndefined();
  });
});
