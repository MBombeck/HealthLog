/**
 * #1276 — a reply that ran into the token ceiling with unlabelled text is the
 * model's answer, cut off, unless this endpoint and model have shown that
 * they reason.
 *
 * The rule read every such reply as reasoning the server did not separate,
 * whenever the ceiling held room for reasoning: a call carrying any level
 * (Off included) to a model that does not reason at all (llama3.1) lost its
 * own truncated answer. The briefing never reached its JSON-shape retry, the
 * Coach named the wrong error, the failure counted toward the bench, and the
 * client learned to ask with `none` for an hour. Now the text is reasoning
 * only once the model has shown it reasons (a reasoning field, a think tag,
 * or a lesson that says so); otherwise it is the answer with
 * `finishReason: "length"`.
 *
 * Driven through the real clients against a loopback server.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/logging/signal", () => ({ emitSignal: () => {} }));

import { LocalOpenAICompatibleClient } from "../local-client";
import { OpenAIClient } from "../openai-client";
import { resetJsonModeDialectCache } from "../json-dialect";
import {
  learnedReasoningDialect,
  resetReasoningDialectCache,
} from "../reasoning/dialect-cache";
import { singleUserTurn, type CompletionParams } from "../types";
import { _resetPinnedDispatcherForTests } from "@/lib/safe-fetch-dispatcher";

const CUT = '{"summary": "Your weight has been stable over the last weeks and';

/** What the next replies carry, one per request; the last one repeats. */
let replies: Array<Record<string, unknown>> = [];
let seen: unknown[] = [];
let server: http.Server;
let origin = "";

function cut() {
  return { message: { role: "assistant", content: CUT }, finish: "length" };
}

function reasonedAnswer() {
  return {
    message: {
      role: "assistant",
      content: '{"summary":"Steady."}',
      reasoning_content: "The readings are flat.",
    },
    finish: "stop",
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push(body.reasoning_effort);
      const next = (replies.length > 1 ? replies.shift() : replies[0]) as {
        message: unknown;
        finish: string;
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            { index: 0, message: next.message, finish_reason: next.finish },
          ],
          usage: { total_tokens: 3000 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  _resetPinnedDispatcherForTests();
  await new Promise<void>((r) => server.close(() => r()));
});

const savedOrigins = process.env.AI_PRIVATE_ORIGINS;

beforeEach(() => {
  process.env.AI_PRIVATE_ORIGINS = origin;
  seen = [];
  replies = [];
  resetReasoningDialectCache();
  resetJsonModeDialectCache();
});

afterEach(() => {
  if (savedOrigins === undefined) delete process.env.AI_PRIVATE_ORIGINS;
  else process.env.AI_PRIVATE_ORIGINS = savedOrigins;
});

function params(effort: "off" | "low"): CompletionParams {
  return {
    ...singleUserTurn({
      system: "s",
      user: "u",
      maxTokens: 2500,
      timeoutMs: 30_000,
      responseFormat: "json",
    }),
    reasoning: { effort, summaries: false },
  };
}

describe.each([
  [
    "the gateway",
    () =>
      new OpenAIClient({
        apiKey: "",
        model: "llama3.1",
        baseUrl: `${origin}/v1`,
        providerType: "openai-compatible",
      }),
    "openai",
  ],
  [
    "the Local client",
    () =>
      new LocalOpenAICompatibleClient({
        baseUrl: `${origin}/v1`,
        model: "llama3.1",
      }),
    "local",
  ],
] as const)("%s", (_, make, provider) => {
  const key = () => ({
    provider,
    endpoint: `${origin}/v1`,
    model: "llama3.1",
  });

  it.each(["off", "low"] as const)(
    "returns a model's cut answer as the answer (level %s), and learns nothing",
    async (effort) => {
      replies = [cut()];
      for (let i = 0; i < 2; i += 1) {
        const result = await make().generateCompletion(params(effort));
        expect(result.content).toBe(CUT);
        expect(result.finishReason).toBe("length");
      }
      // One request per call, each sent as the call asked.
      const asked = effort === "off" ? "none" : "low";
      expect(seen).toEqual([asked, asked]);
      expect(learnedReasoningDialect(key())).toBeUndefined();
    },
  );

  it("reads the same cut text as reasoning once the model has shown it reasons", async () => {
    replies = [reasonedAnswer(), cut()];
    const first = await make().generateCompletion(params("low"));
    expect(first.content).toBe('{"summary":"Steady."}');
    const err = await make()
      .generateCompletion(params("low"))
      .catch((e: unknown) => e as Record<string, unknown>);
    expect(err).toMatchObject({ httpStatus: 0, kind: "reasoning_only" });
  });
});
