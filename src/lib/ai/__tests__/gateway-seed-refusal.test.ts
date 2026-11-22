/**
 * An endpoint that has no `seed` field.
 *
 * Google's Gemini OpenAI-compatible endpoint answers any request carrying
 * `seed` with HTTP 400 `Unknown name "seed": Cannot find field.`. The
 * briefing, status and narrative calls all pass a seed, so every one of them
 * failed on that endpoint. The client now drops the field after the first
 * refusal, asks once more, and remembers it for the endpoint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAIClient } from "../openai-client";
import { resetJsonModeDialectCache } from "../json-dialect";
import {
  isSeedRejection,
  resetMaxTokensRefusals,
  resetSeedRefusals,
} from "../openai-capabilities";
import { isResponseFormatRejection } from "../json-dialect";
import { singleUserTurn } from "../types";

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: (input: unknown, init?: unknown) =>
      (globalThis.fetch as unknown as (i: unknown, n?: unknown) => unknown)(
        input,
        init,
      ),
  };
});
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";

/** The body Google returns, verbatim apart from whitespace. */
const GEMINI_SEED_REFUSAL = JSON.stringify([
  {
    error: {
      code: 400,
      message:
        'Invalid JSON payload received. Unknown name "seed": Cannot find field.',
      status: "INVALID_ARGUMENT",
    },
  },
]);

function ok(content: string) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { total_tokens: 5 },
      }),
  };
}

function refused(body: string) {
  return { ok: false, status: 400, text: () => Promise.resolve(body) };
}

const seededJsonTurn = () => ({
  ...singleUserTurn({ system: "s", user: "u", responseFormat: "json" }),
  seed: 42,
});

const client = () =>
  new OpenAIClient({
    apiKey: "k",
    model: "gemini-3.8-flash",
    baseUrl: GEMINI,
    providerType: "openai-compatible",
  });

beforeEach(() => {
  vi.restoreAllMocks();
  resetSeedRefusals();
  resetMaxTokensRefusals();
  resetJsonModeDialectCache();
});

describe("isSeedRejection", () => {
  it("reads Google's refusal and the common gateway phrasings", () => {
    expect(isSeedRejection(400, GEMINI_SEED_REFUSAL)).toBe(true);
    expect(isSeedRejection(400, '{"error":"Unknown parameter: seed"}')).toBe(
      true,
    );
    expect(isSeedRejection(400, '{"error":"seed is not supported"}')).toBe(
      true,
    );
  });

  it("ignores a complaint about the value, another status, or another field", () => {
    expect(isSeedRejection(400, '{"error":"seed must be an integer"}')).toBe(
      false,
    );
    expect(isSeedRejection(422, GEMINI_SEED_REFUSAL)).toBe(false);
    expect(
      isSeedRejection(400, '{"error":"Unknown parameter: response_format"}'),
    ).toBe(false);
  });

  it("never reads a seed refusal as a JSON-mode refusal", () => {
    expect(isResponseFormatRejection(400, GEMINI_SEED_REFUSAL)).toBe(false);
    expect(
      isResponseFormatRejection(400, '{"error":"Unknown parameter: seed"}'),
    ).toBe(false);
  });
});

describe("OpenAI-compatible gateway — seed refusal", () => {
  it("asks again without seed, keeps JSON mode, and remembers the endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(refused(GEMINI_SEED_REFUSAL))
      .mockResolvedValue(ok('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const gateway = client();
    const first = await gateway.generateCompletion(seededJsonTurn());
    await gateway.generateCompletion(seededJsonTurn());

    expect(first.content).toBe('{"ok":true}');
    // The refused request, its repeat, and the next call without a probe.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(bodies[0]).toHaveProperty("seed", 42);
    expect(bodies[1]).not.toHaveProperty("seed");
    expect(bodies[2]).not.toHaveProperty("seed");
    for (const body of bodies) {
      expect(body.response_format).toEqual({ type: "json_object" });
    }
  });

  it("keeps sending seed to an endpoint that never refused it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    await new OpenAIClient({
      apiKey: "k",
      model: "llama3.1:70b",
      baseUrl: "https://litellm.example.com/v1",
      providerType: "openai-compatible",
    }).generateCompletion(seededJsonTurn());

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toHaveProperty(
      "seed",
      42,
    );
  });

  it("does not ask again when the request carried no seed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(refused(GEMINI_SEED_REFUSAL));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client().generateCompletion(
        singleUserTurn({ system: "s", user: "u", responseFormat: "json" }),
      ),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
