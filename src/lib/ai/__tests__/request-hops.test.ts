/**
 * #1279 — one completion call sends at most two requests, whatever the
 * endpoint answers.
 *
 * A gateway in front of Ollama (LiteLLM: "ollama does not support
 * parameters: ['reasoning_effort']") refuses the reasoning field outright,
 * and the model behind it reasons unasked and answers nothing. The answerless
 * rule asked again with `none`, the refusal rule wrote "send no field" over
 * that lesson, the next request was answerless again, and so on: one call
 * sent requests until something outside stopped it.
 *
 * Driven through the real clients, the real `safeFetch` and the pinned
 * dispatcher against a loopback server that answers each request by a
 * script, so every combination of refusal and answerless reply is walked.
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
import { resetReasoningDialectCache } from "../reasoning/dialect-cache";
import { MAX_REQUESTS_PER_CALL } from "../request-hops";
import { singleUserTurn, type CompletionParams } from "../types";
import { _resetPinnedDispatcherForTests } from "@/lib/safe-fetch-dispatcher";

interface Seen {
  effort: unknown;
  json: boolean;
  stream: boolean;
}

/** Decides one reply from what the request carried. */
type Script = (req: Seen) => { status: number; body: unknown };

const REFUSE_REASONING = {
  status: 400,
  body: {
    error: {
      message:
        "litellm.UnsupportedParamsError: ollama does not support parameters: ['reasoning_effort']",
    },
  },
};

const REFUSE_JSON = {
  status: 400,
  body: { error: { message: "Unsupported parameter: response_format" } },
};

function answerless() {
  return {
    status: 200,
    body: {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "thinking ".repeat(50),
          },
          finish_reason: "length",
        },
      ],
      usage: { total_tokens: 1000 },
    },
  };
}

/** Refuses the reasoning field, reasons without answering otherwise. */
const gatewayRefusingTheField: Script = (req) =>
  req.effort !== undefined ? REFUSE_REASONING : answerless();

/** Refuses the JSON flag and the reasoning field, answerless otherwise. */
const refusesEverything: Script = (req) =>
  req.json
    ? REFUSE_JSON
    : req.effort !== undefined
      ? REFUSE_REASONING
      : answerless();

/** Refuses every streamed request and the reasoning field. */
const refusesStreams: Script = (req) =>
  req.stream
    ? { status: 400, body: { error: { message: "no stream" } } }
    : gatewayRefusingTheField(req);

let server: http.Server;
let origin = "";
let script: Script = gatewayRefusingTheField;
let seen: Seen[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      const request: Seen = {
        effort: body.reasoning_effort,
        json: body.response_format !== undefined,
        stream: body.stream === true,
      };
      seen.push(request);
      // A backstop for the unbounded case, so a failing run ends.
      const reply =
        seen.length > 40
          ? { status: 500, body: { error: { message: "stop" } } }
          : script(request);
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
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
  resetReasoningDialectCache();
  resetJsonModeDialectCache();
});

afterEach(() => {
  if (savedOrigins === undefined) delete process.env.AI_PRIVATE_ORIGINS;
  else process.env.AI_PRIVATE_ORIGINS = savedOrigins;
});

function gateway() {
  return new OpenAIClient({
    apiKey: "",
    model: "qwen3",
    baseUrl: `${origin}/v1`,
    providerType: "openai-compatible",
  });
}

function local() {
  return new LocalOpenAICompatibleClient({
    baseUrl: `${origin}/v1`,
    model: "qwen3",
  });
}

function params(extra: Partial<CompletionParams> = {}): CompletionParams {
  return {
    ...singleUserTurn({
      system: "s",
      user: "u",
      maxTokens: 300,
      timeoutMs: 30_000,
      responseFormat: "json",
    }),
    ...extra,
  };
}

type Call = (p: CompletionParams) => Promise<unknown>;

const CALLERS: ReadonlyArray<[string, () => Call]> = [
  ["the gateway", () => (p) => gateway().generateCompletion(p)],
  ["the Local client", () => (p) => local().generateCompletion(p)],
  [
    "the Local client's stream",
    () => (p) => local().generateCompletionStream(p, () => {}),
  ],
];

/** Run `calls` calls in a row; the requests each one sent. */
async function requestsPerCall(
  call: Call,
  calls: number,
  extra: Partial<CompletionParams> = {},
) {
  const out: Array<{
    requests: Seen[];
    error: Record<string, unknown> | null;
  }> = [];
  for (let i = 0; i < calls; i += 1) {
    const before = seen.length;
    const error = await call(params(extra)).then(
      () => null,
      (e: unknown) => e as Record<string, unknown>,
    );
    out.push({ requests: seen.slice(before), error });
  }
  return out;
}

describe("one call, at most two requests", () => {
  it("the budget is two", () => {
    expect(MAX_REQUESTS_PER_CALL).toBe(2);
  });

  describe.each(CALLERS)("%s", (_, make) => {
    it.each([
      ["a gateway that refuses the reasoning field", gatewayRefusingTheField],
      ["an endpoint that refuses the JSON flag too", refusesEverything],
      ["a server that refuses streams", refusesStreams],
    ] as const)("%s", async (_name, s) => {
      script = s;
      for (const extra of [
        {},
        { reasoning: { effort: "low" as const, summaries: false } },
        { reasoning: { effort: "off" as const, summaries: false } },
      ]) {
        resetReasoningDialectCache();
        resetJsonModeDialectCache();
        const calls = await requestsPerCall(make(), 6, extra);
        for (const { requests } of calls) {
          expect(requests.length).toBeLessThanOrEqual(MAX_REQUESTS_PER_CALL);
          expect(requests.length).toBeGreaterThan(0);
        }
      }
    });

    it("stops asking with `none` once the endpoint refused it, and fails as the reasoning it is", async () => {
      script = gatewayRefusingTheField;
      const calls = await requestsPerCall(make(), 4);
      // The first call: no field, answerless; asked again with `none`,
      // refused. Every later call sends no field and one request.
      expect(calls[0].requests.map((r) => r.effort)).toEqual([
        undefined,
        "none",
      ]);
      for (const later of calls.slice(1)) {
        expect(later.requests.map((r) => r.effort)).toEqual([undefined]);
      }
      for (const { error } of calls) {
        expect(error?.kind).toBe("reasoning_only");
        expect(error?.httpStatus).toBe(0);
      }
      // The first call's answerless request is what it cost.
      expect(calls[0].error?.tokensUsed).toBe(1000);
    });

    it("never asks a model with `none` behind an endpoint that refused the field", async () => {
      script = gatewayRefusingTheField;
      // A call with a level learns that the field is refused first.
      const first = await requestsPerCall(make(), 1, {
        reasoning: { effort: "low", summaries: false },
      });
      expect(first[0].requests.map((r) => r.effort)).toEqual([
        "low",
        undefined,
      ]);
      // Its answerless repeat taught that the model reasons unasked; no call
      // after it sends a reasoning field again.
      const later = await requestsPerCall(make(), 3);
      for (const { requests } of later) {
        expect(requests.map((r) => r.effort)).toEqual([undefined]);
      }
    });
  });
});
