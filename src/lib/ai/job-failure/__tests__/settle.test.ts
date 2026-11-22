import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { settleWitness, type AiJobScope } from "../report";
import {
  noteAiJobEvent,
  noteAiJobFailure,
  withAiJobWitness,
  type AiJobWitness,
  type WitnessEvent,
} from "../witness";

const scope: AiJobScope = { userId: "u1", job: "documentSummary" };

function settled(events: WitnessEvent[], s: AiJobScope = scope) {
  return Object.fromEntries(settleWitness(s, { events }));
}

const failed = (
  failure: "refused" | "timeout",
  capability: "documentAi" | "statusText" | null = "documentAi",
): WitnessEvent => ({
  type: "failed",
  capability,
  providerType: "local",
  failure,
  httpStatus: null,
});

describe("settleWitness", () => {
  it("lets the last word decide: a call that answered after failures clears", () => {
    expect(
      settled([
        failed("refused"),
        { type: "served", capability: "documentAi", providerType: "local" },
      ]),
    ).toEqual({ documentSummary: { state: "served" } });
  });

  it("collects the failed calls after the last answer", () => {
    expect(
      settled([
        { type: "served", capability: "documentAi", providerType: "local" },
        failed("timeout"),
        failed("refused"),
      ]),
    ).toEqual({
      documentSummary: {
        state: "failing",
        calls: [
          { failure: "timeout", httpStatus: null },
          { failure: "refused", httpStatus: null },
        ],
        providerType: "local",
      },
    });
  });

  it("drops a presence refusal the job's own pick admitted", () => {
    expect(
      settled([
        {
          type: "refused",
          capability: "documentAi",
          userId: "u1",
          reason: "no_provider",
          tentative: true,
        },
        { type: "admitted", capability: "documentAi", userId: "u1" },
      ]),
    ).toEqual({ documentSummary: { state: "none" } });
  });

  it("keeps an exact refusal over a later admission", () => {
    expect(
      settled([
        {
          type: "refused",
          capability: "documentAi",
          userId: "u1",
          reason: "consent_required",
          tentative: false,
        },
        { type: "admitted", capability: "documentAi", userId: "u1" },
      ]).documentSummary,
    ).toMatchObject({ state: "refused", reason: "consent_required" });
  });

  it("records another capability's work under its own kind, and ignores other records", () => {
    const out = settled(
      [
        failed("timeout", "statusText"),
        {
          type: "refused",
          capability: "briefing",
          userId: "someone-else",
          reason: "check_failed",
          tentative: false,
        },
      ],
      { userId: "u1", job: "briefing" },
    );
    expect(Object.keys(out)).toEqual(["statusText"]);
    expect(out.statusText).toMatchObject({ state: "failing" });
  });

  it("drops work of a capability that has no kind of its own outside its job", () => {
    expect(
      settled([failed("timeout", null)], { userId: "u1", job: "coachNudge" }),
    ).toMatchObject({ coachNudge: { state: "failing" } });
    expect(
      settled([
        {
          type: "served",
          capability: "medicationExtract",
          providerType: "local",
        },
      ]),
    ).toEqual({});
  });
});

describe("the witness", () => {
  it("notes only inside a tracked job", async () => {
    noteAiJobFailure("budget_exhausted");
    const witness: AiJobWitness = { events: [] };
    await withAiJobWitness(witness, async () => {
      noteAiJobFailure("budget_exhausted");
      noteAiJobEvent({
        type: "served",
        capability: null,
        providerType: "local",
      });
    });
    expect(witness.events.map((e) => e.type)).toEqual(["code", "served"]);
  });
});
