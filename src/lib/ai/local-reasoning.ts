/**
 * What the Local client does with the reasoning a server sends back: collect
 * it for the caller that asked, and keep it out of the answer for every
 * caller. Split out of `local-client.ts`; that client is its only importer.
 *
 * Local servers return the reasoning as `reasoning_content` (llama.cpp,
 * LiteLLM) or `reasoning` (vLLM, Ollama, LM Studio), on the message and on
 * each streamed delta, or inline in `content`.
 * https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md,
 * https://docs.vllm.ai/en/latest/features/reasoning_outputs.html,
 * https://docs.ollama.com/api/openai-compatibility
 *
 * Server-only.
 */
import { emitSignal } from "@/lib/logging/signal";

import { answerOf, reasoningTitleOf } from "./reasoning/support";
import type { CompletionParams, CompletionResult } from "./types";

/**
 * Collects what a call reasoned and reports it to `onReasoning`, for
 * a caller that asked for reasoning; any other caller is told nothing.
 */
export class ReasoningCollector {
  private text = "";
  private titled = false;
  private finished = false;
  constructor(private readonly params: CompletionParams) {}

  private get emit() {
    return this.params.reasoning ? this.params.onReasoning : undefined;
  }

  /** A streamed piece of reasoning; the title goes out once it has closed. */
  add(delta: string): void {
    this.text += delta;
    if (!this.titled && this.emit) {
      const title = reasoningTitleOf(this.text);
      if (title) {
        this.titled = true;
        this.emit({ kind: "title", text: title });
      }
    }
  }

  /** The reasoning is complete (the answer started, or the call ended). */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const text = this.text.trim();
    if (!text || !this.emit) return;
    if (!this.titled) {
      const title = reasoningTitleOf(text);
      if (title) this.emit({ kind: "title", text: title });
    }
    this.emit({ kind: "text", text });
  }

  result(tokens: number | null): CompletionResult["reasoning"] {
    this.finish();
    if (!this.params.reasoning) return undefined;
    this.emit?.({ kind: "done", text: "" });
    const text = this.text.trim();
    return { summary: text ? [text] : [], tokens };
  }
}

/** The reasoning text a non-streamed message carries, if any. */
export function messageReasoning(message: unknown): string | null {
  const m = (message ?? {}) as Record<string, unknown>;
  const text = [m.reasoning_content, m.reasoning].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return text ?? null;
}

/**
 * What one request's endpoint and model have shown of their reasoning
 * (#1276): `room` the ceiling held room for it, `known` the model was seen
 * reasoning before (`knownReasoner`), `seen` records a reply that reasoned.
 */
export interface LocalReasoner {
  room: boolean;
  known: boolean;
  seen(): void;
}

/**
 * #1276 — take the reasoning out of `content` (`answerOf`: an inline
 * `<think>` block or only its closing tag, or, from a model known to reason,
 * unlabelled text that filled a ceiling sized for thinking) and hand it to
 * `collector`. Returns the answer and whether anything was taken. For every
 * caller: reasoning is never an answer, asked for or not.
 */
export function takeReasoning(
  collector: ReasoningCollector,
  content: string,
  reply: {
    fieldedReasoning: boolean;
    finishReason: string | undefined;
    reasoner: LocalReasoner;
  },
): { content: string; took: boolean } {
  const separated = answerOf(content, {
    fieldedReasoning: reply.fieldedReasoning,
    finishReason: reply.finishReason,
    hasToolCalls: false,
    reasoningRoom: reply.reasoner.room,
    knownReasoner: reply.reasoner.known,
  });
  if (separated.reasoning) collector.add(separated.reasoning);
  if (separated.unseparated) {
    emitSignal({
      action: "ai.local.reasoning_unseparated",
      level: "warn",
      meta: { provider: "local" },
    });
  }
  return { content: separated.content, took: separated.content !== content };
}

/**
 * The answer and the reasoning of a non-streamed message: the reasoning
 * fields beside `content`, and whatever `takeReasoning` finds inside it.
 */
export function separateMessage(
  params: CompletionParams,
  message: { content?: string | null } | undefined,
  finishReason: string | undefined,
  reasoner: LocalReasoner,
): { content: string; hadReasoning: boolean; collector: ReasoningCollector } {
  const collector = new ReasoningCollector(params);
  const fielded = messageReasoning(message);
  if (fielded) collector.add(fielded);
  const { content, took } = takeReasoning(collector, message?.content ?? "", {
    fieldedReasoning: fielded !== null,
    finishReason,
    reasoner,
  });
  const hadReasoning = fielded !== null || took;
  if (hadReasoning) reasoner.seen();
  return { content, hadReasoning, collector };
}

/**
 * A leading inline `<think>` block in streamed `content`, split off delta by
 * delta: the reasoning goes to the collector, never to `pass`, which gets the
 * answer as it arrives.
 */
export class StreamedThinkSplitter {
  private state: "detect" | "inside" | "passthrough" = "detect";
  private pending = "";
  /** A `<think>` block opened. */
  opened = false;

  constructor(
    private readonly collector: ReasoningCollector,
    private readonly pass: (text: string) => void,
  ) {}

  push(delta: string): void {
    if (this.state === "passthrough") {
      this.pass(delta);
      return;
    }
    this.pending += delta;
    if (this.state === "detect") {
      const lead = this.pending.replace(/^\s+/, "");
      if (lead.length < "<think>".length && "<think>".startsWith(lead)) {
        return;
      }
      if (!lead.startsWith("<think>")) {
        this.state = "passthrough";
        const out = this.pending;
        this.pending = "";
        this.pass(out);
        return;
      }
      this.state = "inside";
      this.opened = true;
      this.pending = lead.slice("<think>".length);
    }
    const close = this.pending.indexOf("</think>");
    if (close === -1) return;
    this.collector.add(this.pending.slice(0, close));
    this.collector.finish();
    const rest = this.pending
      .slice(close + "</think>".length)
      .replace(/^\s+/, "");
    this.pending = "";
    this.state = "passthrough";
    this.pass(rest);
  }

  /**
   * The stream ended. A reply short enough to still sit in the detector is
   * prose; an unclosed block is reasoning that ran out of budget, and the
   * result says so.
   */
  end(): { unclosed: boolean } {
    const unclosed = this.state === "inside";
    if (this.state === "detect") {
      this.state = "passthrough";
      this.pass(this.pending);
    } else if (unclosed) {
      this.collector.add(this.pending);
    }
    this.pending = "";
    return { unclosed };
  }
}
