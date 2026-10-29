/**
 * #1279 — a model behind an OpenAI-compatible gateway or a local server that
 * reasons however it is asked: gpt-oss behind vLLM accepts only low / medium /
 * high and ignores `reasoning_effort: "none"`, and a GLM chat template reads an
 * effort it does not know as its maximum. Every reply is the thought alone,
 * cut off at the token ceiling (`finish_reason: "length"`).
 *
 * The #1267 repeat with `none` is right for Gemma on Ollama and wasted on
 * these. Driven through the real clients, the real `safeFetch` and the pinned
 * dispatcher against a loopback server, these cases pin the rule: one repeat
 * per call, never `none` again once a `none` reply was answerless too, the
 * thinking room on every later call, and what each failed call cost carried
 * on its error so the day's ledger can charge it.
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
import { resetReasoningDialectCache } from "../reasoning/dialect-cache";
import { singleUserTurn, type CompletionParams } from "../types";
import { _resetPinnedDispatcherForTests } from "@/lib/safe-fetch-dispatcher";

interface SeenRequest {
  reasoningEffort: unknown;
  maxTokens: unknown;
}

/**
 * `always`: the thought fills the ceiling whatever the effort (gpt-oss, GLM).
 * `answers-unreasoned`: the same, except asked with `none` it answers
 * (Gemma 4 on Ollama).
 * `answers-with-room`: ignores the effort and answers once the ceiling leaves
 * it the `high` thinking room (GLM 5.3 behind a gateway, #1276).
 */
let mode: "always" | "answers-unreasoned" | "answers-with-room" = "always";
let server: http.Server;
let origin: string;
let seen: SeenRequest[] = [];

const ANSWER = JSON.stringify({ summary: "Steady." });

function reply(effort: unknown, maxTokens: unknown) {
  const answers =
    (mode === "answers-unreasoned" && effort === "none") ||
    (mode === "answers-with-room" &&
      typeof maxTokens === "number" &&
      maxTokens >= 12_000);
  return {
    id: "chatcmpl-1279",
    object: "chat.completion",
    model: "gpt-oss-120b",
    choices: [
      {
        index: 0,
        message: answers
          ? { role: "assistant", content: ANSWER }
          : {
              role: "assistant",
              content: null,
              reasoning_content: "We need to look at the readings. ".repeat(40),
            },
        finish_reason: answers ? "stop" : "length",
      },
    ],
    usage: { prompt_tokens: 2400, completion_tokens: 300, total_tokens: 2700 },
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({
        reasoningEffort: body.reasoning_effort,
        maxTokens: body.max_tokens ?? body.max_completion_tokens,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          reply(
            body.reasoning_effort,
            body.max_tokens ?? body.max_completion_tokens,
          ),
        ),
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
  mode = "always";
  seen = [];
  emitSignal.mockClear();
  resetReasoningDialectCache();
});

afterEach(() => {
  if (savedOrigins === undefined) delete process.env.AI_PRIVATE_ORIGINS;
  else process.env.AI_PRIVATE_ORIGINS = savedOrigins;
});

function gateway() {
  return new OpenAIClient({
    apiKey: "",
    model: "gpt-oss-120b",
    baseUrl: `${origin}/v1`,
    providerType: "openai-compatible",
  });
}

function local() {
  return new LocalOpenAICompatibleClient({
    baseUrl: `${origin}/v1`,
    model: "gpt-oss-120b",
  });
}

/** A status card call as `runStatusCompletion` shapes it: no level. */
function statusParams(): CompletionParams {
  return singleUserTurn({
    system: "You write the status note.",
    user: "Snapshot: …",
    maxTokens: 300,
    timeoutMs: 30_000,
    responseFormat: "json",
  });
}

function actions(): string[] {
  return emitSignal.mock.calls.map((c) => (c[0] as { action: string }).action);
}

async function failures(
  client: { generateCompletion(p: CompletionParams): Promise<unknown> },
  calls: number,
) {
  const errors: Array<Record<string, unknown>> = [];
  for (let i = 0; i < calls; i += 1) {
    errors.push(
      (await client
        .generateCompletion(statusParams())
        .catch((e) => e)) as Record<string, unknown>,
    );
  }
  return errors;
}

describe.each([
  ["the OpenAI-compatible gateway", gateway, "ai.gateway"],
  ["the Local client", local, "ai.local"],
] as const)(
  "%s, a model that reasons whatever it is asked",
  (_, make, prefix) => {
    it("repeats one call once, then never sends `none` again", async () => {
      const errors = await failures(make(), 5);

      expect(seen.map((s) => s.reasoningEffort)).toEqual([
        undefined,
        "none",
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      for (const err of errors) {
        expect(err).toBeInstanceOf(Error);
        expect(err.kind).toBe("reasoning_only");
        expect(err.httpStatus).toBe(0);
      }
      // One line when the repeat is learned, one when it is learned useless,
      // nothing per call after that.
      expect(actions()).toEqual([
        `${prefix}.reasoning_answerless`,
        `${prefix}.reasoning_unswitchable`,
      ]);
    });

    it("leaves the thinking room on every call after the first", async () => {
      await failures(make(), 3);
      expect(seen.map((s) => s.maxTokens)).toEqual([300, 1324, 1324, 1324]);
    });

    it("carries what a failed call cost on its error, both requests included", async () => {
      const [first, second] = await failures(make(), 2);
      expect(first.tokensUsed).toBe(5400);
      expect(second.tokensUsed).toBe(2700);
    });

    it("still repeats with `none` for a model that answers unreasoned, and bills both requests", async () => {
      mode = "answers-unreasoned";
      const result = await make().generateCompletion(statusParams());
      expect(result.content).toBe(ANSWER);
      expect(result.tokensUsed).toBe(5400);
      expect(seen.map((s) => s.reasoningEffort)).toEqual([undefined, "none"]);
    });
  },
);

/** A daily briefing call as the chain runner hands it to a client. */
function briefingParams(unattended: boolean): CompletionParams {
  return {
    ...singleUserTurn({
      system: "You write the daily briefing.",
      user: "Snapshot: …",
      maxTokens: 300,
      timeoutMs: 30_000,
      responseFormat: "json",
    }),
    reasoning: { effort: "medium", summaries: false },
    ...(unattended ? { unattended: true } : {}),
  };
}

describe.each([
  ["the OpenAI-compatible gateway", gateway],
  ["the Local client", local],
] as const)(
  "#1276 — %s, background work for a model that cannot be switched down",
  (_, make) => {
    it("gives the #1267 repeat the High room, and answers on the first call", async () => {
      mode = "answers-with-room";
      const result = await make().generateCompletion(briefingParams(true));

      expect(result.content).toBe(ANSWER);
      // Two requests, the call's budget: medium at its own room, then the
      // repeat with `none` and the High room the reply showed it needs.
      expect(seen).toEqual([
        { reasoningEffort: "medium", maxTokens: 4396 },
        { reasoningEffort: "none", maxTokens: 12_300 },
      ]);
      // Every later background call starts with the High room.
      seen = [];
      await make().generateCompletion(briefingParams(true));
      expect(seen).toEqual([{ reasoningEffort: "none", maxTokens: 12_300 }]);
    });

    it("gives a status card, which asks no level, the same room", async () => {
      mode = "answers-with-room";
      const result = await make().generateCompletion({
        ...statusParams(),
        unattended: true,
      });
      expect(result.content).toBe(ANSWER);
      expect(seen.map((s) => s.maxTokens)).toEqual([300, 12_300]);
    });

    it("keeps the High room once even `none` is learned useless, and stays at one request", async () => {
      const err = (await make()
        .generateCompletion(briefingParams(true))
        .catch((e) => e)) as Record<string, unknown>;
      expect(err.kind).toBe("reasoning_only");
      expect(seen.map((s) => s.maxTokens)).toEqual([4396, 12_300]);
      seen = [];
      await make()
        .generateCompletion(briefingParams(true))
        .catch(() => {});
      expect(seen).toEqual([{ reasoningEffort: "medium", maxTokens: 12_300 }]);
    });

    it("leaves a call a person is reading at the room of its level", async () => {
      await make()
        .generateCompletion(briefingParams(false))
        .catch(() => {});
      seen = [];
      await make()
        .generateCompletion(briefingParams(false))
        .catch(() => {});
      expect(seen).toEqual([{ reasoningEffort: "medium", maxTokens: 4396 }]);
    });
  },
);
