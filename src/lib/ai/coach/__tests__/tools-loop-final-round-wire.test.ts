/**
 * v1.41 — the forced final round, end to end: the loop's parameters go
 * through each real provider client onto a fake upstream that enforces the
 * provider's documented request rules, so a final round the provider would
 * refuse fails here rather than on the first budget, time, cap or
 * no-progress stop in production.
 *
 * - Anthropic refuses a request whose history holds `tool_use` /
 *   `tool_result` blocks but defines no `tools`; with thinking on it accepts
 *   only `tool_choice` `auto` or `none`.
 *   https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 * - OpenAI Chat Completions refuses `tool_choice` without `tools`.
 *   https://platform.openai.com/docs/api-reference/chat/create
 * - The Codex Responses wire takes `tools` + `tool_choice: "none"`.
 * - Local servers never get `tools` or `tool_choice` (most reject them).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoachToolResult } from "@/lib/ai/coach/tools/executor";

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
vi.mock("@/lib/ai/local-host-allowlist", () => ({
  aiEgressPolicyFor: () => ({}),
}));
const executeCoachTool = vi.fn<(args?: unknown) => Promise<CoachToolResult>>();
vi.mock("@/lib/ai/coach/tools/executor", () => ({
  executeCoachTool: (args: unknown) => executeCoachTool(args),
}));
const runRawCompletionWithFallback = vi.fn();
vi.mock("@/lib/ai/provider-runner", () => ({
  runRawCompletionWithFallback: (args: unknown) =>
    runRawCompletionWithFallback(args),
}));

import { runCoachToolLoop } from "@/lib/ai/coach/tools/loop";
import { createTurnBudget } from "@/lib/ai/coach/tools/turn-budget";
import { COACH_TOOL_DEFS } from "@/lib/ai/coach/tools/definitions";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";
import { AnthropicClient } from "@/lib/ai/anthropic-client";
import { OpenAIClient } from "@/lib/ai/openai-client";
import { CodexClient } from "@/lib/ai/codex-client";
import { LocalOpenAICompatibleClient } from "@/lib/ai/local-client";
import { clearCodexSlugCache } from "@/lib/ai/codex-slug-cache";
import { resetReasoningDialectCache } from "@/lib/ai/reasoning/dialect-cache";
import type { CompletionParams, CompletionResult } from "@/lib/ai/types";

type Body = Record<string, unknown> & {
  tools?: unknown[];
  tool_choice?: unknown;
  messages?: Array<{ content?: unknown }>;
};

const ARGS = JSON.stringify({ metric: "bp", window: "last30days" });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sse(events: unknown[]): Response {
  const text = events
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** Run a turn that calls one tool and then hits the round cap. */
async function capTurn(
  client: {
    generateCompletion(p: CompletionParams): Promise<CompletionResult>;
  },
  providerType: string,
  extra: { reasoning?: CompletionParams["reasoning"] } = {},
) {
  runRawCompletionWithFallback.mockImplementation(
    async ({ params }: { params: CompletionParams }) => ({
      result: await client.generateCompletion({ ...params, ...extra }),
      workingProvider: { providerType },
      fallbackHops: [],
    }),
  );
  return runCoachToolLoop({
    userId: "u1",
    providers: [],
    system: "sys",
    messages: [{ role: "user", content: "How is my blood pressure?" }],
    tools: COACH_TOOL_DEFS,
    reach: UNBOUNDED_REACH,
    budget: createTurnBudget({
      payer: "operator",
      initialInputTokens: 10,
      limits: { tokens: 1e9, wallMs: 1e9, maxRounds: 2 },
    }),
  });
}

function bodies(mock: ReturnType<typeof vi.fn>): Body[] {
  return mock.mock.calls.map(
    (c) => JSON.parse((c[1] as { body: string }).body) as Body,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  executeCoachTool.mockReset();
  runRawCompletionWithFallback.mockReset();
  executeCoachTool.mockResolvedValue({ present: true, data: { mean: 128 } });
  clearCodexSlugCache();
  resetReasoningDialectCache();
});

describe("the forced final round on each provider wire", () => {
  it("Anthropic: keeps the tools beside tool_use history, tool_choice none, thinking on", async () => {
    const upstream = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Body;
      const blocks = (body.messages ?? []).flatMap((m) =>
        Array.isArray(m.content) ? (m.content as Array<{ type: string }>) : [],
      );
      const toolHistory = blocks.some(
        (b) => b.type === "tool_use" || b.type === "tool_result",
      );
      if (toolHistory && !body.tools) {
        return json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "Requests which include `tool_use` or `tool_result` blocks must define tools.",
            },
          },
          400,
        );
      }
      const choice = (body.tool_choice as { type?: string } | undefined)?.type;
      if (body.thinking && choice && choice !== "auto" && choice !== "none") {
        return json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "Thinking may not be enabled when tool_choice forces tool use.",
            },
          },
          400,
        );
      }
      if (!toolHistory) {
        return json({
          content: [
            { type: "thinking", thinking: "Look it up.", signature: "sig-1" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_metric_table",
              input: JSON.parse(ARGS),
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }
      return json({
        content: [{ type: "text", text: "Your readings average 128." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 6 },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const client = new AnthropicClient({
      apiKey: "sk-ant-test",
      model: "claude-opus-4-7",
    });

    const out = await capTurn(client, "anthropic", {
      reasoning: { effort: "medium", summaries: true },
    });

    expect(out.result.content).toBe("Your readings average 128.");
    expect(out.stop).toEqual({ reason: "cap", rounds: 2 });
    const final = bodies(upstream)[1];
    expect(final.tools).toHaveLength(COACH_TOOL_DEFS.length);
    expect(final.tool_choice).toEqual({ type: "none" });
    expect(final.thinking).toMatchObject({ type: "adaptive" });
  });

  it("OpenAI: sends tool_choice none only beside the tools", async () => {
    const upstream = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Body;
      if (body.tool_choice !== undefined && !body.tools) {
        return json(
          {
            error: {
              message:
                "Invalid value for 'tool_choice': 'tool_choice' is only allowed when 'tools' are specified.",
              type: "invalid_request_error",
              param: "tool_choice",
              code: null,
            },
          },
          400,
        );
      }
      const round = (body.messages ?? []).length;
      return json(
        round <= 2
          ? {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: { name: "get_metric_table", arguments: ARGS },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: { total_tokens: 30 },
            }
          : {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "Your readings average 128.",
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { total_tokens: 40 },
            },
      );
    });
    vi.stubGlobal("fetch", upstream);
    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4.1",
      baseUrl: "https://api.openai.com/v1",
    });

    const out = await capTurn(client, "admin-key");

    expect(out.result.content).toBe("Your readings average 128.");
    const final = bodies(upstream)[1];
    expect(final.tools).toHaveLength(COACH_TOOL_DEFS.length);
    expect(final.tool_choice).toBe("none");
  });

  it("Codex: sends the tool definitions with tool_choice none", async () => {
    let n = 0;
    const upstream = vi.fn(async () => {
      n += 1;
      return n === 1
        ? sse([
            {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                call_id: "call_1",
                name: "get_metric_table",
                arguments: ARGS,
              },
            },
            { type: "response.completed", response: { usage: {} } },
          ])
        : sse([
            {
              type: "response.output_item.done",
              item: {
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: "Your readings average 128." },
                ],
              },
            },
            { type: "response.completed", response: { usage: {} } },
          ]);
    });
    vi.stubGlobal("fetch", upstream);
    const client = new CodexClient({
      accessToken: "t",
      accountId: "a",
      onTokenRefresh: vi.fn(),
      slugChain: ["gpt-5.5"],
    });

    const out = await capTurn(client, "codex");

    expect(out.result.content).toBe("Your readings average 128.");
    const final = bodies(upstream)[1];
    expect(final.tools).toHaveLength(COACH_TOOL_DEFS.length);
    expect(final.tool_choice).toBe("none");
  });

  it("Local: never sends tools or tool_choice, final round included", async () => {
    const upstream = vi.fn(async () =>
      json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Your readings average 128.",
            },
            finish_reason: "stop",
          },
        ],
        usage: { total_tokens: 20 },
      }),
    );
    vi.stubGlobal("fetch", upstream);
    const client = new LocalOpenAICompatibleClient({
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });
    const params: CompletionParams = {
      system: "sys",
      messages: [{ role: "user", content: "u" }],
      tools: COACH_TOOL_DEFS,
      toolChoice: "none",
    };

    const result = await client.generateCompletion(params);

    expect(result.content).toBe("Your readings average 128.");
    const sent = bodies(upstream)[0];
    expect(sent).not.toHaveProperty("tools");
    expect(sent).not.toHaveProperty("tool_choice");
  });
});
