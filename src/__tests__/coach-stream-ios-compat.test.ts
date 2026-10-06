/**
 * No Coach stream frame added after the native client shipped may carry a
 * top-level key that client already decodes.
 *
 * The native client decodes every frame into one flat struct —
 * `{ type, token, conversationId, messageId, code, message, suggestion,
 * metricSource, usage }` — and dispatches on `type`, ignoring a type it does
 * not know. That makes an unknown frame harmless only while its keys are
 * unknown too: a new frame that reused `message` or `usage` with a different
 * shape would make the whole frame fail to decode, and a new frame that
 * reused one with the same shape would leak a value into whatever the client
 * does with that key. So a new frame names its payload with a key of its own
 * (`step`, `result`, `followUps`, `clarification`, and since v1.41
 * `activity`, `memoryNote` with `note`, `planProposal` with `proposal`).
 *
 * Reads the frame list from the Zod mirror (`stream-events.ts`), which a
 * type test holds equal to `CoachStreamEvent`, so a frame added to the
 * TypeScript union is seen here too.
 *
 * Checked by breaking it: adding `message: z.string()` to the `step` frame in
 * `stream-events.ts` turns the second test red and names the frame and key.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { coachStreamEventSchema } from "@/lib/ai/coach/stream-events";

/** The keys the shipped native client decodes, `type` aside. */
const NATIVE_CLIENT_KEYS = [
  "token",
  "conversationId",
  "messageId",
  "code",
  "message",
  "suggestion",
  "metricSource",
  "usage",
] as const;

/** The frames the shipped client was built against; they own those keys. */
const FRAMES_THE_CLIENT_KNOWS = new Set([
  "token",
  "provenance",
  "suggestion",
  "suggestedAction",
  "reasoning",
  "done",
  "error",
]);

type FrameSchema = z.ZodObject<{ type: z.ZodLiteral<string> } & z.ZodRawShape>;

function frames(): Array<{ type: string; keys: string[] }> {
  return (coachStreamEventSchema.options as readonly FrameSchema[]).map(
    (option) => ({
      type: String(option.shape.type.value),
      keys: Object.keys(option.shape),
    }),
  );
}

/** Every `frame.key` pair where a newer frame reuses a native-client key. */
function collisions(list: Array<{ type: string; keys: string[] }>): string[] {
  const reserved: ReadonlySet<string> = new Set(NATIVE_CLIENT_KEYS);
  return list
    .filter((frame) => !FRAMES_THE_CLIENT_KNOWS.has(frame.type))
    .flatMap((frame) =>
      frame.keys
        .filter((key) => reserved.has(key))
        .map((key) => `${frame.type}.${key}`),
    );
}

describe("Coach stream frames stay decodable by the shipped native client", () => {
  it("reads every frame, including the ones added after the client shipped", () => {
    const types = frames().map((frame) => frame.type);
    // An empty or partial list would agree with anything.
    expect(types).toEqual(
      expect.arrayContaining([
        ...FRAMES_THE_CLIENT_KNOWS,
        "step",
        "result",
        "followUps",
        "clarification",
        "activity",
        "memoryNote",
        "planProposal",
      ]),
    );
    expect(
      types.filter((type) => !FRAMES_THE_CLIENT_KNOWS.has(type)).length,
    ).toBeGreaterThan(0);
  });

  it("no newer frame carries a key the native client decodes", () => {
    expect(
      collisions(frames()),
      "rename the payload key: the native client decodes these keys on every frame",
    ).toEqual([]);
  });

  it("the check flags a colliding frame", () => {
    expect(
      collisions([
        { type: "step", keys: ["type", "step", "message"] },
        { type: "done", keys: ["type", "conversationId", "messageId"] },
      ]),
    ).toEqual(["step.message"]);
  });
});
