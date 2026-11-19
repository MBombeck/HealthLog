/**
 * Antigravity CLI (`agy acp`) provider for HealthLog.
 *
 * Speaks ACP v1 (JSON-RPC 2.0, one message per line) over the stdio of an
 * `agy acp` child process. Each call starts its own child process and ACP
 * session, and nothing is shared between calls.
 *
 * Guarantees:
 * - The child runs in an empty temporary workspace, deleted when the call ends.
 * - The child gets an allowlisted environment only, so app secrets stay out.
 * - The child runs with `--gemini-dir` set to the user's profile directory.
 *   Without per-user `--gemini-dir` the CLI keeps its state under $HOME/.gemini,
 *   which every user would share. `--app-data-dir` is not used.
 * - The agent gets no MCP servers and no fs or terminal capabilities.
 * - Every permission request from the agent is refused.
 *
 * Pinned to agy 1.5.10: the flags, the `initialize` shape, and the authentication flow.
 *
 * @see docs/antigravity-cli-architecture.md
 * @see docs/antigravity-cli-transport-decision.md
 */

import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AcpConnection } from "./antigravity-acp";
import { ANTIGRAVITY_ERRORS, AntigravityError } from "./antigravity-errors";
import { antigravityChildEnv } from "./antigravity-bin";
import type { AntigravityPromptCapabilities } from "./antigravity-capability-cache";
import {
  SETUP_TIMEOUT_MS,
  resultOrThrow,
  type AntigravityModel,
  type AntigravityModelOptions,
  type AntigravityThoughtLevelOptions,
  thoughtLevelOptionsOf,
  mapToAgyThoughtLevel,
  resolveTargetThoughtLevel,
  modelOptionsOf,
  agyLevelRank,
  selectModel,
  selectThoughtLevel,
  stricterReasoningLevel,
} from "./antigravity-options";

export { antigravityChildEnv };
export {
  type AntigravityPromptCapabilities,
  type AntigravityModel,
  type AntigravityModelOptions,
  type AntigravityThoughtLevelOptions,
  thoughtLevelOptionsOf,
  mapToAgyThoughtLevel,
  resolveTargetThoughtLevel,
  modelOptionsOf,
  agyLevelRank,
};

export {
  ANTIGRAVITY_ERRORS,
  antigravityReasonOf,
  type AntigravityFailureReason,
} from "./antigravity-errors";
import type {
  AIProvider,
  AiContentPart,
  AiMessage,
  CompletionParams,
  CompletionResult,
  ProviderType,
} from "./types";
import type { ReasoningEffort } from "./reasoning-effort";
import { isReasoningLevel, type ReasoningLevel } from "./reasoning/levels";
import { reasoningTitleOf } from "./reasoning/support";
import {
  isValidAntigravityProfileId,
  normalizeAntigravityProfileRoot,
} from "./antigravity-profile-cleanup";

// ─── Constants ───────────────────────────────────────────────

/** Image MIME types accepted by ACP `image` blocks. */
const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Document MIME types accepted by ACP `resource` blocks. */
const ALLOWED_DOCUMENT_MIMES = new Set(["application/pdf"]);

const PROTOCOL_VERSION = 1;
const DEFAULT_PROMPT_TIMEOUT_MS = 60_000;

const ROLE_LABEL: Record<AiMessage["role"], string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool result",
};

// ─── Profile directory ───────────────────────────────────────

/**
 * The profile directory the CLI must use for this user, or null when none is
 * set up. Null means the provider must not run: without an isolated profile
 * the CLI would fall back to the server's login, which every user shares.
 *
 * The directory must already exist. Nothing in HealthLog creates it yet.
 *
 * IMPORTANT: When ANTIGRAVITY_PROFILE_ROOT is set, HealthLog stores a
 * profileId (32-char hex) in the user record and uses that as the directory
 * name, NOT the user's database ID. This function accepts the stored
 * profileId, not the database userId.
 */
export function antigravityProfileDir(profileId: string): string | null {
  const root = normalizeAntigravityProfileRoot();
  if (!root || !isValidAntigravityProfileId(profileId)) {
    if (profileId && !isValidAntigravityProfileId(profileId)) {
      console.warn(`Invalid Antigravity profile ID: "${profileId}"`);
    }
    return null;
  }
  const dir = join(root, profileId);
  return existsSync(dir) ? dir : null;
}

/**
 * Where the CLI keeps one user's state, as the two flags that select it.
 * `geminiDir` is the per-user directory. `appDataDir` is left empty; with
 * the per-user geminiDir the `--app-data-dir` flag is not needed and would
 * create an unwanted nested subdirectory.
 */
export interface AntigravityProfileLocation {
  geminiDir: string;
}

/** The location for this user, or null when the profile does not exist yet. */
export function antigravityProfileLocation(
  profileId: string,
): AntigravityProfileLocation | null {
  const dir = antigravityProfileDir(profileId);
  if (dir === null) return null;
  // geminiDir is the per-user directory (not the shared root). The CLI stores
  // the OAuth token at <geminiDir>/antigravity-oauth-token, so it must point
  // to the user's own directory to keep credentials isolated and to place the
  // token file inside the volume-mounted path where it survives container
  // recreates.
  return {
    geminiDir: dir,
  };
}

// ─── ACP wire types ──────────────────────────────────────────

interface AcpInitializeResult {
  agentInfo?: { name?: string };
  /** The CLI reports prompt support here. `embeddedContext` covers embedded resources such as PDFs. */
  agentCapabilities?: {
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
  };
}

interface AcpSessionNewResult {
  sessionId?: string;
  configOptions?: unknown;
}

interface AcpPromptResult {
  stopReason?: string;
}

type AcpPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType: string; blob: string };
    };

// ─── Request helpers ─────────────────────────────────────────

/** Arguments that start the ACP server for one user's profile. */
function acpArgs(profile: AntigravityProfileLocation): string[] {
  return [
    "acp",
    "--sandbox",
    "--disable-telemetry",
    "--gemini-dir",
    profile.geminiDir,
  ];
}

function initializeParams() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: "HealthLog", version: "1.0.0" },
    // The server advertises systemPrompt.append: true in its initialize
    // response. Sending systemPrompt here injects it into the model's
    // actual system instructions (not just the conversation text), making
    // it effective against cascade/planning mode.
    systemPrompt: AGY_NO_TOOL_HINT,
  };
}

/** Read the prompt capabilities out of an `initialize` result. Missing means unsupported. */
function promptCapabilitiesOf(
  init: AcpInitializeResult | undefined,
): AntigravityPromptCapabilities {
  const caps = init?.agentCapabilities?.promptCapabilities;
  return {
    image: caps?.image === true,
    embeddedContext: caps?.embeddedContext === true,
  };
}

/**
 * Streams the agent's own thinking to the caller's `onReasoning`, as the
 * OpenAI and Anthropic clients do. agy sends it as `agent_thought_chunk`
 * updates, and only for models that think out loud (for example
 * claude-opus-4-6-thinking). The title follows the first bold line, live.
 * The full text and `done` follow once the reply is complete. Nothing is
 * sent unless the caller asked for summaries.
 */
export function thoughtStream(params: CompletionParams): {
  add(chunk: string): void;
  finish(): void;
} {
  const emit = params.reasoning?.summaries ? params.onReasoning : undefined;
  let text = "";
  let title: string | null = null;
  let finished = false;
  return {
    add(chunk: string) {
      if (!emit || finished) return;
      text += chunk;
      const next = reasoningTitleOf(text);
      if (next && next !== title) {
        title = next;
        emit({ kind: "title", text: next });
      }
    },
    finish() {
      if (!emit || finished) return;
      finished = true;
      if (!text.trim()) return;
      emit({ kind: "text", text: text.trim() });
      emit({ kind: "done", text: "" });
    },
  };
}

/** The text of a message's content, with media parts left out. */
function textOf(content: AiMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (part): part is Extract<AiContentPart, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

/**
 * Injected into every agy session via two channels:
 *   1. The ACP `initialize` systemPrompt field (model's actual system prompt)
 *   2. Prepended to every conversation text block (belt-and-suspenders)
 *
 * Without it the model enters cascade/agentic mode (jetski) and attempts to
 * execute internal planning steps (Step_Generic). With --sandbox those steps
 * are refused and the session returns empty content; without --sandbox the
 * cascade runs indefinitely (jetski_mode_turbo, 3-min timeout).
 *
 * The document clause prevents a second, PDF-specific trigger: when the prompt
 * carries an ACP resource block the model sometimes tries to open the file with
 * a filesystem tool. The resource content is already embedded in the message,
 * so no tool is needed; saying so keeps the model out of agentic mode.
 */
const AGY_NO_TOOL_HINT =
  "You are a conversational assistant. Respond directly with plain text. " +
  "Do not use any internal tools, planning steps, or execution steps. " +
  "If the message includes attached documents or files, their content is already " +
  "fully embedded in this message — you can read them directly without using any tools. " +
  "Provide your complete answer in a single text reply.";

/**
 * Turn the request into ACP prompt blocks: one text block (system prompt
 * followed by the conversation), then one block per attached image or PDF.
 */
export function buildPromptBlocks(params: CompletionParams): AcpPromptBlock[] {
  const { messages } = params;
  const single = messages.length === 1 && messages[0].role === "user";
  const body = single
    ? textOf(messages[0].content)
    : messages
        .map((m) => `${ROLE_LABEL[m.role]}: ${textOf(m.content)}`)
        .join("\n\n");
  // Append the no-tool hint to the system prompt. It keeps the model from
  // entering agentic mode; placing it in the system block ensures agy treats
  // it as an instruction rather than part of the conversation.
  const system = params.system
    ? `${params.system}\n\n${AGY_NO_TOOL_HINT}`
    : AGY_NO_TOOL_HINT;
  const text = [system, body].filter(Boolean).join("\n\n");

  const blocks: AcpPromptBlock[] = [];
  if (text) blocks.push({ type: "text", text });

  let documents = 0;
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image") {
        if (!ALLOWED_IMAGE_MIMES.has(part.mediaType)) {
          throw new AntigravityError(
            `Unsupported image MIME type: ${part.mediaType}`,
            ANTIGRAVITY_ERRORS.PROMPT_FAILED,
          );
        }
        blocks.push({
          type: "image",
          mimeType: part.mediaType,
          data: part.dataBase64,
        });
      } else if (part.type === "document") {
        if (!ALLOWED_DOCUMENT_MIMES.has(part.mediaType)) {
          throw new AntigravityError(
            `Unsupported document MIME type: ${part.mediaType}`,
            ANTIGRAVITY_ERRORS.PROMPT_FAILED,
          );
        }
        documents += 1;
        blocks.push({
          type: "resource",
          resource: {
            uri: `healthlog://attachment-${documents}.pdf`,
            mimeType: part.mediaType,
            blob: part.dataBase64,
          },
        });
      }
    }
  }
  return blocks;
}

function cancelledError(): AntigravityError {
  return new AntigravityError(
    "Request cancelled",
    ANTIGRAVITY_ERRORS.CANCELLED,
  );
}

// ─── Client ──────────────────────────────────────────────────

interface AntigravityClientOptions {
  /**
   * The user's profile. Get it from {@link antigravityProfileLocation}. A
   * client without a profile would run under the shared login, so there is no
   * default.
   */
  profile: AntigravityProfileLocation;
  /**
   * The model the user picked. Null or missing keeps the CLI's own default.
   * A model the CLI does not offer fails the call.
   */
  model?: string | null;
  /** Prompt timeout used when the call does not set `timeoutMs`. */
  timeoutMs?: number;
}

export class AntigravityClient implements AIProvider {
  readonly type: ProviderType = "antigravity";
  /** ACP tools are the agent's own tools, not HealthLog function calling. */
  readonly supportsTools = false;
  /**
   * Stamped by `bindResponseTimeout` from the user's
   * `User.aiResponseTimeoutSeconds` setting. Null means use the client's own
   * `options.timeoutMs` or `DEFAULT_PROMPT_TIMEOUT_MS`.
   */
  responseTimeoutSeconds: number | null = null;
  /** See `AIProvider.reasoningEffort`; stamped by the resolver. */
  reasoningEffort: ReasoningEffort | null = null;
  /**
   * Effective administrative/record reasoning cap for this provider instance
   * (e.g. where the operator cap or frugal level clamps saved effort).
   */
  policyCap?: ReasoningLevel | null = null;

  constructor(private readonly options: AntigravityClientOptions) {}

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    return this.run(params);
  }

  async generateCompletionStream(
    params: CompletionParams,
    onDelta: (delta: string) => void,
  ): Promise<CompletionResult> {
    return this.run(params, onDelta);
  }

  private async run(
    params: CompletionParams,
    onDelta?: (delta: string) => void,
  ): Promise<CompletionResult> {
    const { signal } = params;
    if (signal?.aborted) throw cancelledError();

    const blocks = buildPromptBlocks(params);
    const workDir = mkdtempSync(join(tmpdir(), "healthlog-acp-"));
    const state: { connection: AcpConnection | null; done: boolean } = {
      connection: null,
      done: false,
    };

    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(cancelledError());
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // The race below handles the rejection. This keeps it from surfacing as
    // unhandled when the work finishes first.
    cancelled.catch(() => undefined);

    try {
      const execution = this.execute(workDir, blocks, params, onDelta, state);
      execution.catch(() => undefined);
      return await Promise.race([execution, cancelled]);
    } finally {
      state.done = true;
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      await state.connection?.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  private async execute(
    workDir: string,
    blocks: AcpPromptBlock[],
    params: CompletionParams,
    onDelta: ((delta: string) => void) | undefined,
    state: { connection: AcpConnection | null; done: boolean },
  ): Promise<CompletionResult> {
    const args = acpArgs(this.options.profile);

    const connection = await AcpConnection.start(args, {
      cwd: workDir,
      env: antigravityChildEnv(join(this.options.profile.geminiDir)),
    });
    state.connection = connection;
    if (state.done) {
      // The call was cancelled while the process was starting.
      await connection.close();
      throw cancelledError();
    }

    // Register the chunk handler before any call() so no session/update
    // notification can arrive on the wire before the callback is in place.
    const chunks: string[] = [];
    const thoughts = thoughtStream(params);
    connection.onSessionUpdate = (update) => {
      if (
        update.sessionUpdate === "agent_thought_chunk" &&
        update.content?.type === "text" &&
        typeof update.content.text === "string"
      ) {
        thoughts.add(update.content.text);
        return;
      }
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text" &&
        typeof update.content.text === "string"
      ) {
        chunks.push(update.content.text);
        onDelta?.(update.content.text);
      }
    };

    const init = resultOrThrow<AcpInitializeResult>(
      await connection.call("initialize", initializeParams(), SETUP_TIMEOUT_MS),
      ANTIGRAVITY_ERRORS.SESSION_FAILED,
      "Antigravity initialize failed",
    );

    const promptCaps = promptCapabilitiesOf(init);
    if (blocks.some((b) => b.type === "image") && !promptCaps.image) {
      throw new AntigravityError(
        "Antigravity does not accept image input",
        ANTIGRAVITY_ERRORS.PROMPT_FAILED,
      );
    }
    if (
      blocks.some((b) => b.type === "resource") &&
      !promptCaps.embeddedContext
    ) {
      throw new AntigravityError(
        "Antigravity does not accept PDF input",
        ANTIGRAVITY_ERRORS.PROMPT_FAILED,
      );
    }

    const session = resultOrThrow<AcpSessionNewResult>(
      await connection.call(
        "session/new",
        // agentScript: true was tested and had no effect — agy ignores it.
        // The cascade is suppressed instead via systemPrompt in initializeParams.
        { cwd: workDir, mcpServers: [] },
        SETUP_TIMEOUT_MS,
      ),
      ANTIGRAVITY_ERRORS.SESSION_FAILED,
      "Antigravity session could not be created",
    );
    if (typeof session?.sessionId !== "string") {
      throw new AntigravityError(
        "Antigravity session could not be created",
        ANTIGRAVITY_ERRORS.SESSION_FAILED,
      );
    }

    let activeConfigOptions: unknown = session.configOptions;
    let modelChanged = false;
    let unknownConfigAfterModelChange = false;
    const modelOptions = modelOptionsOf(activeConfigOptions);
    const selected = this.options.model ?? null;
    if (selected) {
      if (modelOptions && modelOptions.currentModel !== selected)
        modelChanged = true;
      const modelRes = await selectModel(
        connection,
        session.sessionId,
        modelOptions,
        selected,
      );
      if (modelRes.configOptions) {
        activeConfigOptions = modelRes.configOptions;
      } else if (modelChanged) {
        // Model changed but no fresh configOptions returned: config is unknown
        activeConfigOptions = null;
        unknownConfigAfterModelChange = true;
      }
    }

    const thoughtOptions = thoughtLevelOptionsOf(activeConfigOptions);
    const effectiveCap = stricterReasoningLevel(
      params.reasoning?.maxEffort,
      this.policyCap,
    );
    const capRank = agyLevelRank(effectiveCap);
    if (unknownConfigAfterModelChange && capRank !== null && capRank < 3) {
      // Under a restrictive mandatory cap, unknown config after a model change
      // cannot verify whether the thought level satisfies the cap. Fail closed before prompt.
      throw new AntigravityError(
        "Antigravity thought level could not be selected",
        ANTIGRAVITY_ERRORS.SESSION_FAILED,
      );
    }
    const isExplicit =
      params.reasoning?.explicit ?? params.reasoning?.effort === "off";
    const targetLevel = resolveTargetThoughtLevel(
      params.reasoning?.effort,
      this.reasoningEffort,
      effectiveCap,
      isExplicit,
    );
    let appliedThoughtLevel: string | null = null;
    if (targetLevel || effectiveCap) {
      const thoughtRes = await selectThoughtLevel(
        connection,
        session.sessionId,
        thoughtOptions,
        targetLevel,
        effectiveCap,
      );
      appliedThoughtLevel = thoughtRes.appliedLevel;
      if (thoughtRes.configOptions) {
        activeConfigOptions = thoughtRes.configOptions;
      }
    } else if (thoughtOptions) {
      appliedThoughtLevel = thoughtOptions.currentLevel;
    }

    const timeoutMs =
      params.timeoutMs ??
      (this.responseTimeoutSeconds != null
        ? this.responseTimeoutSeconds * 1_000
        : undefined) ??
      this.options.timeoutMs ??
      DEFAULT_PROMPT_TIMEOUT_MS;
    const response = await connection.call(
      "session/prompt",
      { sessionId: session.sessionId, prompt: blocks },
      timeoutMs,
    );
    const stopReason = (response.result as AcpPromptResult | undefined)
      ?.stopReason;
    const content = chunks.join("");
    if (response.error) {
      const quota = /quota/i.test(response.error.message);
      throw new AntigravityError(
        quota ? "Antigravity quota exceeded" : "Antigravity prompt failed",
        quota
          ? ANTIGRAVITY_ERRORS.QUOTA_EXCEEDED
          : ANTIGRAVITY_ERRORS.PROMPT_FAILED,
        response.error,
      );
    }

    // A "cancelled" stop reason can appear when the CLI's sandbox rejects an
    // internal step (e.g. a Step_Generic from the agy backend), even though
    // the AI already emitted a complete text reply. Only treat it as an error
    // when no content arrived at all.
    if (stopReason === "cancelled" && !content) {
      throw new AntigravityError(
        "Antigravity cancelled the turn",
        ANTIGRAVITY_ERRORS.PROMPT_FAILED,
      );
    }
    if (!content) {
      throw new AntigravityError(
        "Antigravity returned an empty reply",
        ANTIGRAVITY_ERRORS.PROMPT_FAILED,
      );
    }

    thoughts.finish();
    const effectiveRequested =
      effectiveCap === "off"
        ? "off"
        : params.reasoning?.effort === "off"
          ? params.reasoning.effort
          : isExplicit && params.reasoning?.effort
            ? params.reasoning.effort
            : (this.reasoningEffort ?? params.reasoning?.effort ?? null);
    const requestedEffort = effectiveRequested;
    const initialLevel = thoughtOptions?.currentLevel ?? "high";
    const appliedRank = agyLevelRank(appliedThoughtLevel);
    const requestedRank = agyLevelRank(requestedEffort);
    const defaultRank = agyLevelRank(initialLevel) ?? 3;

    const isValidAppliedLevel =
      typeof appliedThoughtLevel === "string" &&
      isReasoningLevel(appliedThoughtLevel);

    const isDowngraded =
      isValidAppliedLevel &&
      appliedRank !== null &&
      ((requestedEffort === "off" || requestedEffort === "none") &&
      appliedThoughtLevel === "low"
        ? true
        : requestedRank !== null
          ? appliedRank < requestedRank
          : effectiveCap !== null &&
            effectiveCap !== undefined &&
            appliedRank < defaultRank);

    return {
      content,
      tokensUsed: null,
      // The model the session ran on, as the CLI reports it. Without a
      // reported model, the provider id is recorded.
      model: selected ?? modelOptions?.currentModel ?? "antigravity",
      providerType: "antigravity",
      finishReason: stopReason === "max_tokens" ? "length" : "stop",
      ...(isDowngraded && appliedThoughtLevel
        ? {
            reasoning: {
              summary: [],
              tokens: null,
              downgradedTo: appliedThoughtLevel as ReasoningLevel,
            },
          }
        : {}),
    };
  }
}

/**
 * Start the CLI for one profile and open a session, without sending any
 * prompt. The connection test uses this. It proves the profile is logged in,
 * and it reports the prompt capabilities. The profile's auth state decides the
 * outcome: "Authentication required" maps to AUTH_REQUIRED.
 * If model is supplied, it selects that model before discovering capabilities.
 */
export async function probeAntigravity(
  profile: AntigravityProfileLocation,
  model?: string | null,
): Promise<{
  capabilities: AntigravityPromptCapabilities;
  agentName: string | null;
  /** The model selector the CLI offers, or null when it offers none. */
  modelOptions: AntigravityModelOptions | null;
  /** The thought level selector the CLI offers, or null when it offers none. */
  thoughtLevelOptions?: AntigravityThoughtLevelOptions | null;
}> {
  const workDir = mkdtempSync(join(tmpdir(), "healthlog-acp-"));
  let connection: AcpConnection | null = null;
  try {
    connection = await AcpConnection.start(acpArgs(profile), {
      cwd: workDir,
      env: antigravityChildEnv(profile.geminiDir),
    });
    const init = resultOrThrow<AcpInitializeResult>(
      await connection.call("initialize", initializeParams(), SETUP_TIMEOUT_MS),
      ANTIGRAVITY_ERRORS.SESSION_FAILED,
      "Antigravity initialize failed",
    );
    const session = resultOrThrow<AcpSessionNewResult>(
      await connection.call(
        "session/new",
        { cwd: workDir, mcpServers: [] },
        SETUP_TIMEOUT_MS,
      ),
      ANTIGRAVITY_ERRORS.SESSION_FAILED,
      "Antigravity session could not be created",
    );
    if (typeof session?.sessionId !== "string") {
      throw new AntigravityError(
        "Antigravity session could not be created",
        ANTIGRAVITY_ERRORS.SESSION_FAILED,
      );
    }
    let activeConfigOptions: unknown = session.configOptions;
    const modelOptions = modelOptionsOf(activeConfigOptions);
    if (
      model &&
      modelOptions &&
      modelOptions.models.some((m) => m.id === model)
    ) {
      const modelRes = await selectModel(
        connection,
        session.sessionId,
        modelOptions,
        model,
      );
      if (modelRes.configOptions) {
        activeConfigOptions = modelRes.configOptions;
      }
    }
    return {
      capabilities: promptCapabilitiesOf(init),
      agentName: init?.agentInfo?.name ?? null,
      modelOptions,
      thoughtLevelOptions: thoughtLevelOptionsOf(activeConfigOptions),
    };
  } finally {
    await connection?.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ─── Provider wiring ─────────────────────────────────────────

if (process.env.ANTIGRAVITY_AUTO_APPROVE_TOOLS) {
  console.warn(
    "[antigravity] ANTIGRAVITY_AUTO_APPROVE_TOOLS is deprecated and ignored. Strict permissions are enforced.",
  );
}

/** Whether a stored profile id has a profile folder on the server and is connected. */
export function antigravityAvailable(
  profileId: string | null,
  connectionStatus?: string | null,
): boolean {
  if (connectionStatus !== undefined && connectionStatus !== "connected") {
    return false;
  }
  return profileId !== null && antigravityProfileLocation(profileId) !== null;
}

/**
 * The client for a user's stored profile and model. Null when the user has no
 * profile, the profile folder is gone, or connection is not active.
 */
export function antigravityProviderFor(user: {
  antigravityProfileId: string | null;
  antigravityModel: string | null;
  antigravityConnectionStatus: string | null;
}): AntigravityClient | null {
  if (!user.antigravityProfileId) return null;
  if (user.antigravityConnectionStatus !== "connected") {
    return null;
  }
  const profile = antigravityProfileLocation(user.antigravityProfileId);
  if (!profile) return null;
  return new AntigravityClient({ profile, model: user.antigravityModel });
}
