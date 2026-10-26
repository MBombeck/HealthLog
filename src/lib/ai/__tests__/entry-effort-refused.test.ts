/**
 * #1126 / #1279 — a gateway or local entry whose own reasoning setting the
 * endpoint refuses.
 *
 * The entry's setting (`reasoningEffort`, stamped by the resolver) rides a
 * call that carries no level of its own. An endpoint that refuses the field
 * (LiteLLM in front of Ollama) answered every such call with a 400 that was
 * never learned, because only the call's own level counted as "sent": every
 * call failed. It is learned now like any refused field: the call is asked
 * once more without it, inside its budget of two requests, later calls send
 * no field, and the lesson is reported once.
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

const emitSignal = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logging/signal", () => ({
  emitSignal: (...a: unknown[]) => emitSignal(...a),
}));

import { LocalOpenAICompatibleClient } from "../local-client";
import { OpenAIClient } from "../openai-client";
import { resetJsonModeDialectCache } from "../json-dialect";
import { resetReasoningDialectCache } from "../reasoning/dialect-cache";
import { singleUserTurn } from "../types";
import { _resetPinnedDispatcherForTests } from "@/lib/safe-fetch-dispatcher";

const ANSWER = '{"summary":"Steady."}';

let server: http.Server;
let origin = "";
let seen: unknown[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push(body.reasoning_effort);
      if (body.reasoning_effort !== undefined) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "litellm.UnsupportedParamsError: ollama does not support parameters: ['reasoning_effort']",
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: ANSWER },
              finish_reason: "stop",
            },
          ],
          usage: { total_tokens: 400 },
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
  emitSignal.mockClear();
  resetReasoningDialectCache();
  resetJsonModeDialectCache();
});

afterEach(() => {
  if (savedOrigins === undefined) delete process.env.AI_PRIVATE_ORIGINS;
  else process.env.AI_PRIVATE_ORIGINS = savedOrigins;
});

function gateway() {
  const client = new OpenAIClient({
    apiKey: "",
    model: "qwen3",
    baseUrl: `${origin}/v1`,
    providerType: "openai-compatible",
  });
  client.reasoningEffort = "high";
  return client;
}

function local() {
  const client = new LocalOpenAICompatibleClient({
    baseUrl: `${origin}/v1`,
    model: "qwen3",
  });
  client.reasoningEffort = "high";
  return client;
}

/** A status card call: no level of its own. */
const params = () =>
  singleUserTurn({
    system: "s",
    user: "u",
    maxTokens: 300,
    timeoutMs: 30_000,
    responseFormat: "json",
  });

describe.each([
  ["the gateway", gateway],
  ["the Local client", local],
] as const)("%s, an entry setting the endpoint refuses", (_, make) => {
  it("answers on the second request, and later calls send no field", async () => {
    const first = await make().generateCompletion(params());
    expect(first.content).toBe(ANSWER);
    expect(seen).toEqual(["high", undefined]);

    seen = [];
    for (let i = 0; i < 3; i += 1) {
      expect((await make().generateCompletion(params())).content).toBe(ANSWER);
    }
    expect(seen).toEqual([undefined, undefined, undefined]);
  });

  it("says so once, not once per call", async () => {
    for (let i = 0; i < 3; i += 1) await make().generateCompletion(params());
    const lines = emitSignal.mock.calls
      .map((c) => c[0] as { action: string })
      .filter((s) => s.action === "ai.provider.reasoning_field_refused");
    expect(lines).toHaveLength(1);
  });
});
