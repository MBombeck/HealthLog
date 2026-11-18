import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AntigravityClient,
  ANTIGRAVITY_ERRORS,
  modelOptionsOf,
  thoughtLevelOptionsOf,
  mapToAgyThoughtLevel,
  resolveTargetThoughtLevel,
  probeAntigravity,
} from "../antigravity-client";
import { singleUserTurn } from "../types";

const { dbState } = vi.hoisted(() => ({
  dbState: {
    adminSettings: null as unknown,
    userLevel: null as string | null,
    failAdmin: false,
    failUser: false,
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(async () => {
        if (dbState.failAdmin) throw new Error("admin db error");
        return dbState.adminSettings;
      }),
    },
    user: {
      findUnique: vi.fn(async () => {
        if (dbState.failUser) throw new Error("user db error");
        return { aiUsageLevel: dbState.userLevel };
      }),
    },
    dailyAiSpend: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
  },
}));

vi.mock("../provider-health-ledger", () => ({
  postgresProviderHealthLedger: {
    getSkipHints: vi.fn(async () => new Map()),
    recordSuccess: vi.fn(async () => {}),
    recordFailure: vi.fn(async () => {}),
  },
}));

// Mock the child_process spawn
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));
// Mock fs-temp operations
vi.mock("fs", () => ({
  mkdtempSync: vi.fn(() => "/tmp/healthlog-acp-test"),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));
vi.mock("os", () => ({
  tmpdir: () => "/tmp",
}));
import { spawn } from "child_process";
const TEST_PROFILE = {
  geminiDir: "/var/lib/healthlog/antigravity/user-1",
};
/** The model selector, in the shape ACP session configOptions define. */
const MODEL_OPTION = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "model-fast",
  options: [
    { value: "model-fast", name: "Fast" },
    { value: "model-pro", name: "Pro" },
  ],
};
const DEFAULT_CONFIG_OPTIONS: unknown[] = [MODEL_OPTION];
function createMockProcess({
  spawnEvent = true,
  configOptions = DEFAULT_CONFIG_OPTIONS,
  setConfigFails = false,
  thoughtChunks = [],
  setReturnsConfigOptions = true,
  setReturnsStaleConfig = false,
}: {
  spawnEvent?: boolean;
  configOptions?: unknown[];
  setConfigFails?: boolean;
  thoughtChunks?: string[];
  setReturnsConfigOptions?: boolean;
  setReturnsStaleConfig?: boolean;
} = {}) {
  const handlers: {
    stdout: ((data: Buffer) => void)[];
    stderr: ((data: Buffer) => void)[];
    close: ((code: number | null) => void)[];
    error: ((err: Error) => void)[];
    exit: ((code: number | null, signal: string | null) => void)[];
    spawn: (() => void)[];
  } = { stdout: [], stderr: [], close: [], error: [], exit: [], spawn: [] };
  let stdinBuffer = "";
  const proc = {
    stdin: {
      on: vi.fn(),
      write: vi.fn((data: string) => {
        stdinBuffer += data;
        // Process complete lines
        const lines = stdinBuffer.split("\n");
        stdinBuffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            handleMockMessage(msg);
          } catch {}
        }
      }),
    },
    stdout: {
      on: vi.fn((event: string, handler: (data: Buffer) => void) => {
        if (event === "data") handlers.stdout.push(handler);
      }),
    },
    stderr: {
      on: vi.fn((event: string, handler: (data: Buffer) => void) => {
        if (event === "data") handlers.stderr.push(handler);
      }),
      resume: vi.fn(),
    },
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as string | null,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      if (event === "close")
        handlers.close.push(handler as (code: number | null) => void);
      if (event === "error")
        handlers.error.push(handler as (err: Error) => void);
      if (event === "exit")
        handlers.exit.push(
          handler as (code: number | null, signal: string | null) => void,
        );
      if (event === "spawn") {
        handlers.spawn.push(handler as () => void);
        if (spawnEvent) setTimeout(() => handlers.spawn.forEach((h) => h()), 0);
      }
    }),
    kill: vi.fn(() => {
      setTimeout(() => handlers.exit.forEach((h) => h(0, null)), 10);
    }),
  };
  function sendMessage(msg: unknown) {
    const data = Buffer.from(JSON.stringify(msg) + "\n");
    handlers.stdout.forEach((h) => h(data));
  }
  function handleMockMessage(msg: {
    jsonrpc: string;
    id?: number;
    method?: string;
    params?: unknown;
  }) {
    if (msg.method === "initialize") {
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "Mock ACP", version: "0.0.1" },
          agentCapabilities: {
            promptCapabilities: { image: true, embeddedContext: true },
          },
        },
      });
    } else if (msg.method === "session/new") {
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "test-session-123",
          configOptions,
        },
      });
    } else if (msg.method === "session/set_config_option") {
      if (setConfigFails) {
        sendMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "Invalid value" },
        });
      } else {
        const val = (msg.params as { configId?: string; value?: unknown })
          ?.value;
        const configId = (msg.params as { configId?: string; value?: unknown })
          ?.configId;
        const updatedConfigOptions = Array.isArray(configOptions)
          ? configOptions.map((opt) =>
              typeof opt === "object" &&
              opt !== null &&
              (opt as { id?: string }).id === configId &&
              !setReturnsStaleConfig
                ? { ...opt, currentValue: val }
                : opt,
            )
          : configOptions;
        sendMessage({
          jsonrpc: "2.0",
          id: msg.id,
          result: setReturnsConfigOptions
            ? { configOptions: updatedConfigOptions }
            : {},
        });
      }
    } else if (msg.method === "session/prompt") {
      for (const text of thoughtChunks) {
        sendMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "test-session-123",
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text },
            },
          },
        });
      }
      // Send message chunk
      sendMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "test-session-123",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "This is the answer." },
          },
        },
      });
      // Send response
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "end_turn" },
      });
    } else if (msg.method === "session/reject_permission") {
      sendMessage({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else {
      sendMessage({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
  return { proc, sendMessage, handlers };
}
describe("AntigravityClient", () => {
  let mockSpawn: ReturnType<typeof vi.fn>;
  let mockProcess: ReturnType<typeof createMockProcess>;
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    mockSpawn = spawn as ReturnType<typeof vi.fn>;
    mockSpawn.mockReturnValue(mockProcess.proc);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  describe("type", () => {
    it('has type="antigravity"', () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      expect(client.type).toBe("antigravity");
    });
  });
  describe("ACP server flags and strict permissions", () => {
    async function startedArgs(): Promise<string[]> {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      void client
        .generateCompletion(singleUserTurn({ system: "", user: "Hi" }))
        .catch(() => undefined);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
      return mockSpawn.mock.calls[0][1] as string[];
    }

    it("never passes --dangerously-skip-permissions and keeps strict sandbox", async () => {
      const args = await startedArgs();
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args).toContain("--sandbox");
      expect(args).toEqual([
        "acp",
        "--sandbox",
        "--disable-telemetry",
        "--gemini-dir",
        TEST_PROFILE.geminiDir,
      ]);
    });
  });

  describe("supportsTools", () => {
    it("is false (ACP tools are NOT HealthLog function calling)", () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      expect(client.supportsTools).toBe(false);
    });
  });
  describe("generateCompletion", () => {
    it("returns a CompletionResult with required fields", async () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      const result = await client.generateCompletion(
        singleUserTurn({ system: "You are helpful.", user: "Hello" }),
      );
      expect(typeof result.content).toBe("string");
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.providerType).toBe("antigravity");
      expect(typeof result.model).toBe("string");
      expect(
        result.tokensUsed === null || typeof result.tokensUsed === "number",
      ).toBe(true);
    });
    it("includes system prompt in the request", async () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      await client.generateCompletion(
        singleUserTurn({ system: "Custom system", user: "Hello" }),
      );
      // Check that prompt was sent
      expect(mockProcess.proc.stdin.write).toHaveBeenCalled();
    });
    it("handles multimodal content (image)", async () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      const result = await client.generateCompletion(
        singleUserTurn({
          system: "Describe images.",
          user: "What's this?",
          images: [
            {
              mediaType: "image/png",
              dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
            },
          ],
        }),
      );
      expect(typeof result.content).toBe("string");
    });
  });
  describe("generateCompletionStream", () => {
    it("calls onDelta for each chunk", async () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      const chunks: string[] = [];
      const result = await client.generateCompletionStream(
        singleUserTurn({ system: "sys", user: "user" }),
        (delta) => chunks.push(delta),
      );
      expect(chunks.length).toBeGreaterThan(0);
      expect(typeof result.content).toBe("string");
    });
  });
  describe("error handling", () => {
    it("throws CLI_UNAVAILABLE when spawn error event fires", async () => {
      const { proc, handlers } = createMockProcess({ spawnEvent: false });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      const promise = client.generateCompletion(
        singleUserTurn({ system: "s", user: "u" }),
      );
      // Emit error after a tick
      setTimeout(() => {
        handlers.error.forEach((h) => h(new Error("spawn ENOENT")));
      }, 10);
      await expect(promise).rejects.toMatchObject({
        code: ANTIGRAVITY_ERRORS.CLI_UNAVAILABLE,
      });
    });
  });
  describe("process lifecycle", () => {
    it("cleans up process after completion", async () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      await client.generateCompletion(
        singleUserTurn({ system: "s", user: "u" }),
      );
      // Process should be killed
      expect(mockProcess.proc.kill).toHaveBeenCalled();
    });
    it("cleans up process on error", async () => {
      const { proc, sendMessage } = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      // Make session/new fail
      const originalHandle = proc.stdin.write;
      proc.stdin.write = vi.fn((data: string) => {
        const msg = JSON.parse(data.trim());
        if (msg.method === "session/new") {
          sendMessage({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: "Auth required" },
          });
        }
        return originalHandle.call(proc.stdin, data);
      });
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      await expect(
        client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
      ).rejects.toThrow();
      expect(proc.kill).toHaveBeenCalled();
    });
  });
  describe("tool suppression", () => {
    it("appends the no-tool hint to the system prompt sent to agy", async () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      await client.generateCompletion(
        singleUserTurn({ system: "You are a coach.", user: "Cześć" }),
      );
      const msgs = sentMessages(mockProcess.proc.stdin.write);
      const promptMsg = msgs.find((m) => m.method === "session/prompt");
      expect(promptMsg).toBeDefined();
      const blocks = (promptMsg?.params as { prompt?: unknown[] })?.prompt;
      const textBlock = (
        blocks as Array<{ type: string; text?: string }> | undefined
      )?.find((b) => b.type === "text");
      expect(textBlock?.text).toContain("You are a coach.");
      expect(textBlock?.text).toContain(
        "Do not use any internal tools, planning steps, or execution steps",
      );
    });
    it("includes the hint even when no system prompt is provided", async () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      await client.generateCompletion(
        singleUserTurn({ system: "", user: "Hi" }),
      );
      const msgs = sentMessages(mockProcess.proc.stdin.write);
      const promptMsg = msgs.find((m) => m.method === "session/prompt");
      const blocks = (promptMsg?.params as { prompt?: unknown[] })?.prompt;
      const textBlock = (
        blocks as Array<{ type: string; text?: string }> | undefined
      )?.find((b) => b.type === "text");
      expect(textBlock?.text).toContain(
        "Do not use any internal tools, planning steps, or execution steps",
      );
    });
    it("throws PROMPT_FAILED when agy returns end_turn with no content", async () => {
      // Simulate the Step_Generic scenario: session/prompt returns end_turn
      // with no preceding agent_message_chunk notifications.
      const { proc, sendMessage } = createMockProcess();
      (proc.stdin.write as ReturnType<typeof vi.fn>).mockImplementation(
        (data: string) => {
          const lines = data.split("\n").filter((l) => l.trim());
          for (const line of lines) {
            const msg = JSON.parse(line) as {
              method?: string;
              id?: number;
              params?: unknown;
            };
            if (msg.method === "initialize") {
              sendMessage({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: 1,
                  agentInfo: { name: "Mock ACP", version: "0.0.1" },
                  agentCapabilities: {
                    promptCapabilities: { image: true, embeddedContext: true },
                  },
                },
              });
            } else if (msg.method === "session/new") {
              sendMessage({
                jsonrpc: "2.0",
                id: msg.id,
                result: { sessionId: "empty-session", configOptions: [] },
              });
            } else if (msg.method === "session/prompt") {
              // No agent_message_chunk — only the completion signal
              sendMessage({
                jsonrpc: "2.0",
                id: msg.id,
                result: { stopReason: "end_turn" },
              });
            }
          }
        },
      );
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      await expect(
        client.generateCompletion(
          singleUserTurn({ system: "", user: "Cześć" }),
        ),
      ).rejects.toMatchObject({ code: ANTIGRAVITY_ERRORS.PROMPT_FAILED });
    });
  });
});
/** Every JSON-RPC message the client wrote to the child's stdin, in order. */
function sentMessages(
  write: unknown,
): { id?: number; method?: string; params?: Record<string, unknown> }[] {
  const calls = (write as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.flatMap(([data]) =>
    String(data)
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line)),
  );
}
describe("modelOptionsOf", () => {
  it("reads the model selector from the ACP configOptions shape", () => {
    expect(modelOptionsOf([MODEL_OPTION])).toEqual({
      configId: "model",
      models: [
        { id: "model-fast", name: "Fast" },
        { id: "model-pro", name: "Pro" },
      ],
      currentModel: "model-fast",
    });
  });
  it("flattens grouped options", () => {
    const grouped = {
      ...MODEL_OPTION,
      options: [
        {
          group: "Google",
          options: [{ value: "model-pro", name: "Pro" }],
        },
      ],
    };
    expect(modelOptionsOf([grouped])?.models).toEqual([
      { id: "model-pro", name: "Pro" },
    ]);
  });
  it("matches by id when the category is missing", () => {
    const byId = { ...MODEL_OPTION, category: undefined };
    expect(modelOptionsOf([byId])?.configId).toBe("model");
  });
  it("skips entries without a string value and names models by value when unnamed", () => {
    const option = {
      ...MODEL_OPTION,
      options: [{ value: "model-x" }, { value: 7 }, { name: "No value" }],
    };
    expect(modelOptionsOf([option])?.models).toEqual([
      { id: "model-x", name: "model-x" },
    ]);
  });
  it("returns null when the CLI offers no model selector", () => {
    expect(modelOptionsOf([{ id: "mode", type: "select" }])).toBeNull();
    expect(modelOptionsOf(undefined)).toBeNull();
  });
});
describe("AntigravityClient model selection", () => {
  let mockSpawn: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn = spawn as ReturnType<typeof vi.fn>;
  });
  it("sets the chosen model before the prompt is sent", async () => {
    const { proc } = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
      model: "model-pro",
    });
    const result = await client.generateCompletion(
      singleUserTurn({ system: "s", user: "u" }),
    );
    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    const setAt = methods.indexOf("session/set_config_option");
    expect(setAt).toBeGreaterThan(methods.indexOf("session/new"));
    expect(setAt).toBeLessThan(methods.indexOf("session/prompt"));
    const setCall = sentMessages(proc.stdin.write).find(
      (m) => m.method === "session/set_config_option",
    );
    expect(setCall?.params).toEqual({
      sessionId: "test-session-123",
      configId: "model",
      value: "model-pro",
    });
    expect(result.model).toBe("model-pro");
  });
  it("keeps the CLI default and reports its model when no model is chosen", async () => {
    const { proc } = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({ profile: TEST_PROFILE });
    const result = await client.generateCompletion(
      singleUserTurn({ system: "s", user: "u" }),
    );
    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    expect(methods).not.toContain("session/set_config_option");
    expect(result.model).toBe("model-fast");
  });
  it("does not send a change when the chosen model is already the current one", async () => {
    const { proc } = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
      model: "model-fast",
    });
    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));
    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    expect(methods).not.toContain("session/set_config_option");
  });
  it("fails before the prompt when the CLI does not offer the chosen model", async () => {
    const { proc } = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
      model: "model-retired",
    });
    await expect(
      client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
    ).rejects.toMatchObject({ code: ANTIGRAVITY_ERRORS.MODEL_UNAVAILABLE });
    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    expect(methods).not.toContain("session/prompt");
    expect(proc.kill).toHaveBeenCalled();
  });
  it("fails before the prompt when the CLI rejects the model change", async () => {
    const { proc } = createMockProcess({ setConfigFails: true });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
      model: "model-pro",
    });
    await expect(
      client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
    ).rejects.toMatchObject({ code: ANTIGRAVITY_ERRORS.SESSION_FAILED });
    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    expect(methods).not.toContain("session/prompt");
  });
  it("fails when the CLI offers no model selector at all", async () => {
    const { proc } = createMockProcess({ configOptions: [] });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
      model: "model-pro",
    });
    await expect(
      client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
    ).rejects.toMatchObject({ code: ANTIGRAVITY_ERRORS.MODEL_UNAVAILABLE });
  });
});

describe("agent thinking stream", () => {
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn = spawn as ReturnType<typeof vi.fn>;
  });

  const thinkingParams = (onReasoning: (event: unknown) => void) => ({
    ...singleUserTurn({ system: "", user: "Hi" }),
    reasoning: { effort: "medium" as const, summaries: true },
    onReasoning,
  });

  it("sends the live title, then the full thinking and done, and keeps it out of the reply", async () => {
    mockSpawn.mockReturnValue(
      createMockProcess({
        thoughtChunks: [
          "**Checking the",
          " figures**\n",
          "17 times 23 is 391.",
        ],
      }).proc,
    );
    const events: { kind: string; text: string }[] = [];
    const client = new AntigravityClient({ profile: TEST_PROFILE });

    const result = await client.generateCompletion(
      thinkingParams((event) => events.push(event as never)),
    );

    expect(events).toEqual([
      { kind: "title", text: "Checking the figures" },
      {
        kind: "text",
        text: "**Checking the figures**\n17 times 23 is 391.",
      },
      { kind: "done", text: "" },
    ]);
    expect(result.content).toBe("This is the answer.");
  });

  it("sends nothing when the caller did not ask for summaries", async () => {
    mockSpawn.mockReturnValue(
      createMockProcess({ thoughtChunks: ["**Thinking**\nhidden"] }).proc,
    );
    const onReasoning = vi.fn();
    const client = new AntigravityClient({ profile: TEST_PROFILE });

    await client.generateCompletion({
      ...singleUserTurn({ system: "", user: "Hi" }),
      onReasoning,
    });

    expect(onReasoning).not.toHaveBeenCalled();
  });

  it("sends nothing when the model streamed no thinking", async () => {
    mockSpawn.mockReturnValue(createMockProcess().proc);
    const onReasoning = vi.fn();
    const client = new AntigravityClient({ profile: TEST_PROFILE });

    await client.generateCompletion(thinkingParams(onReasoning));

    expect(onReasoning).not.toHaveBeenCalled();
  });
});

describe("thoughtLevelOptionsOf and mapToAgyThoughtLevel", () => {
  it("discovers thought_level options and choices correctly", () => {
    const config = [
      {
        id: "thought_level",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ];
    const opts = thoughtLevelOptionsOf(config);
    expect(opts).toEqual({
      configId: "thought_level",
      choices: ["low", "medium", "high"],
      currentLevel: "high",
    });
  });

  it("handles grouped or string-only options", () => {
    const config = [
      {
        id: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [{ options: [{ value: "low" }, "medium"] }, { value: "high" }],
      },
    ];
    const opts = thoughtLevelOptionsOf(config);
    expect(opts).toEqual({
      configId: "thought_level",
      choices: ["low", "medium", "high"],
      currentLevel: "medium",
    });
  });

  it("returns null when configOptions is not array or has no thought_level", () => {
    expect(thoughtLevelOptionsOf(null)).toBeNull();
    expect(thoughtLevelOptionsOf([])).toBeNull();
    expect(thoughtLevelOptionsOf([{ id: "other", type: "select" }])).toBeNull();
  });

  it("safely maps taxonomy to ACP thought levels", () => {
    expect(mapToAgyThoughtLevel("low")).toBe("low");
    expect(mapToAgyThoughtLevel("medium")).toBe("medium");
    expect(mapToAgyThoughtLevel("high")).toBe("high");
    // Off/none safe mapping to low
    expect(mapToAgyThoughtLevel("off")).toBe("low");
    expect(mapToAgyThoughtLevel("none")).toBe("low");
    expect(mapToAgyThoughtLevel(null)).toBeNull();
    expect(mapToAgyThoughtLevel("unknown")).toBeNull();
  });
});

describe("AntigravityClient thought level ACP selection", () => {
  let mockSpawn: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn = spawn as ReturnType<typeof vi.fn>;
  });

  const THOUGHT_CONFIG_OPTIONS = [
    MODEL_OPTION,
    {
      id: "thought_level",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ];

  it("selects low thought level via session/set_config_option before prompt", async () => {
    const { proc } = createMockProcess({
      configOptions: THOUGHT_CONFIG_OPTIONS,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({ profile: TEST_PROFILE });

    await client.generateCompletion({
      ...singleUserTurn({ system: "s", user: "u" }),
      reasoning: { effort: "low", summaries: false },
    });

    const messages = sentMessages(proc.stdin.write);
    const setCalls = messages.filter(
      (m) => m.method === "session/set_config_option",
    );
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].params).toEqual({
      sessionId: "test-session-123",
      configId: "thought_level",
      value: "low",
    });

    const methods = messages.map((m) => m.method);
    const setAt = methods.indexOf("session/set_config_option");
    const promptAt = methods.indexOf("session/prompt");
    expect(setAt).toBeGreaterThan(methods.indexOf("session/new"));
    expect(setAt).toBeLessThan(promptAt);
    expect(methods.filter((m) => m === "session/prompt")).toHaveLength(1);
  });

  it("safely maps off to low for antigravity", async () => {
    const { proc } = createMockProcess({
      configOptions: THOUGHT_CONFIG_OPTIONS,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({ profile: TEST_PROFILE });

    await client.generateCompletion({
      ...singleUserTurn({ system: "s", user: "u" }),
      reasoning: { effort: "off", summaries: false },
    });

    const setCalls = sentMessages(proc.stdin.write).filter(
      (m) => m.method === "session/set_config_option",
    );
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].params).toEqual({
      sessionId: "test-session-123",
      configId: "thought_level",
      value: "low",
    });
  });

  it("ensures model selection occurs before thought level selection", async () => {
    const { proc } = createMockProcess({
      configOptions: THOUGHT_CONFIG_OPTIONS,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
      model: "model-pro",
    });
    client.reasoningEffort = "low";

    await client.generateCompletion({
      ...singleUserTurn({ system: "s", user: "u" }),
    });

    const messages = sentMessages(proc.stdin.write);
    const setCalls = messages.filter(
      (m) => m.method === "session/set_config_option",
    );
    expect(setCalls).toHaveLength(2);
    expect(setCalls[0].params).toEqual({
      sessionId: "test-session-123",
      configId: "model",
      value: "model-pro",
    });
    expect(setCalls[1].params).toEqual({
      sessionId: "test-session-123",
      configId: "thought_level",
      value: "low",
    });

    const methods = messages.map((m) => m.method);
    expect(methods.filter((m) => m === "session/prompt")).toHaveLength(1);
  });

  it("leaves CLI default without set_config_option when target matches current", async () => {
    const { proc } = createMockProcess({
      configOptions: THOUGHT_CONFIG_OPTIONS,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({ profile: TEST_PROFILE });

    // currentValue in mock is "high"; requesting "high" requires no set_config_option
    await client.generateCompletion({
      ...singleUserTurn({ system: "s", user: "u" }),
      reasoning: { effort: "high", summaries: false },
    });

    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    expect(methods).not.toContain("session/set_config_option");
    expect(methods.filter((m) => m === "session/prompt")).toHaveLength(1);
  });

  it("uses client reasoningEffort when params.reasoning is absent", async () => {
    const { proc } = createMockProcess({
      configOptions: THOUGHT_CONFIG_OPTIONS,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({ profile: TEST_PROFILE });
    client.reasoningEffort = "low";

    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    const setCalls = sentMessages(proc.stdin.write).filter(
      (m) => m.method === "session/set_config_option",
    );
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].params).toEqual({
      sessionId: "test-session-123",
      configId: "thought_level",
      value: "low",
    });
  });

  it("does not fail prompt and sends no set_config_option when older agy lacks thought_level", async () => {
    // DEFAULT_CONFIG_OPTIONS has no thought_level
    const { proc } = createMockProcess({
      configOptions: DEFAULT_CONFIG_OPTIONS,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({ profile: TEST_PROFILE });

    const result = await client.generateCompletion({
      ...singleUserTurn({ system: "s", user: "u" }),
      reasoning: { effort: "low", summaries: false },
    });

    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    expect(methods).not.toContain("session/set_config_option");
    expect(methods.filter((m) => m === "session/prompt")).toHaveLength(1);
    expect(result.content).toBe("This is the answer.");
  });

  it("does not send set_config_option for unsupported choice", async () => {
    const LIMITED_OPTIONS = [
      MODEL_OPTION,
      {
        id: "thought_level",
        type: "select",
        currentValue: "high",
        options: [{ value: "high" }], // only high is advertised
      },
    ];
    const { proc } = createMockProcess({ configOptions: LIMITED_OPTIONS });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({ profile: TEST_PROFILE });

    const result = await client.generateCompletion({
      ...singleUserTurn({ system: "s", user: "u" }),
      reasoning: { effort: "low", summaries: false },
    });

    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    expect(methods).not.toContain("session/set_config_option");
    expect(methods.filter((m) => m === "session/prompt")).toHaveLength(1);
    expect(result.content).toBe("This is the answer.");
  });

  it("throws AntigravityError when session/set_config_option fails", async () => {
    const { proc } = createMockProcess({
      configOptions: THOUGHT_CONFIG_OPTIONS,
      setConfigFails: true,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({ profile: TEST_PROFILE });

    await expect(
      client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: { effort: "low", summaries: false },
      }),
    ).rejects.toThrow("Antigravity thought level could not be selected");

    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    expect(methods).not.toContain("session/prompt");
  });

  it("prioritizes saved provider selection over generic Coach default", async () => {
    const { proc } = createMockProcess({
      configOptions: THOUGHT_CONFIG_OPTIONS,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({ profile: TEST_PROFILE });
    client.reasoningEffort = "low";

    // Coach turn passes generic default "medium", but user saved "low" on provider
    await client.generateCompletion({
      ...singleUserTurn({ system: "s", user: "u" }),
      reasoning: { effort: "medium", summaries: true },
    });

    const setCalls = sentMessages(proc.stdin.write).filter(
      (m) => m.method === "session/set_config_option",
    );
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].params).toEqual({
      sessionId: "test-session-123",
      configId: "thought_level",
      value: "low",
    });
  });

  it("skips thought level when model changed but no configOptions returned", async () => {
    const { proc } = createMockProcess({
      configOptions: THOUGHT_CONFIG_OPTIONS,
      setReturnsConfigOptions: false,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
      model: "model-pro",
    });
    client.reasoningEffort = "low";

    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    const setCalls = sentMessages(proc.stdin.write).filter(
      (m) => m.method === "session/set_config_option",
    );
    // Only model selection is sent because set_config_option response returned no configOptions
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].params).toEqual({
      sessionId: "test-session-123",
      configId: "model",
      value: "model-pro",
    });
  });

  it("reports downgradedTo when requested effort cannot be applied directly", async () => {
    const { proc } = createMockProcess({
      configOptions: THOUGHT_CONFIG_OPTIONS,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({ profile: TEST_PROFILE });

    // Request "off", which agy maps to "low"
    const result = await client.generateCompletion({
      ...singleUserTurn({ system: "s", user: "u" }),
      reasoning: { effort: "off", summaries: false },
    });

    expect(result.reasoning?.downgradedTo).toBe("low");
  });

  it("combines coach reasoningForTurn operator cap and saved high to enforce cap on client", async () => {
    const { proc } = createMockProcess({
      configOptions: THOUGHT_CONFIG_OPTIONS,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
    });
    client.reasoningEffort = "high";

    // Simulate Coach turn where operator pays (payer = "operator")
    const { reasoningForTurn } = await import("../coach/turn/reasoning");
    const turnReasoning = reasoningForTurn("high", "operator");
    expect(turnReasoning.effort).toBe("medium");
    expect(turnReasoning.maxEffort).toBe("medium");

    // Client receives turnReasoning on params.reasoning
    await client.generateCompletion({
      ...singleUserTurn({ system: "s", user: "u" }),
      reasoning: turnReasoning,
    });

    const setCalls = sentMessages(proc.stdin.write).filter(
      (m) => m.method === "session/set_config_option",
    );
    // Even though provider has saved "high", operator cap "medium" clamps target to "medium"
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].params).toEqual({
      sessionId: "test-session-123",
      configId: "thought_level",
      value: "medium",
    });
  });

  it("enforces admin low cap on saved high for user payer in coach turn", async () => {
    const { proc } = createMockProcess({
      configOptions: THOUGHT_CONFIG_OPTIONS,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
    });
    client.reasoningEffort = "high";

    const { reasoningForTurn } = await import("../coach/turn/reasoning");
    const turnReasoning = reasoningForTurn("high", "user", "low");
    expect(turnReasoning.effort).toBe("low");
    expect(turnReasoning.maxEffort).toBe("low");

    await client.generateCompletion({
      ...singleUserTurn({ system: "s", user: "u" }),
      reasoning: turnReasoning,
    });

    const setCalls = sentMessages(proc.stdin.write).filter(
      (m) => m.method === "session/set_config_option",
    );
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].params).toEqual({
      sessionId: "test-session-123",
      configId: "thought_level",
      value: "low",
    });
  });

  it("reports downgradedTo when requested effort is off with saved high", async () => {
    const { proc } = createMockProcess({
      configOptions: THOUGHT_CONFIG_OPTIONS,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
    });
    client.reasoningEffort = "high";

    const result = await client.generateCompletion({
      ...singleUserTurn({ system: "s", user: "u" }),
      reasoning: { effort: "off", summaries: false },
    });

    expect(result.reasoning?.downgradedTo).toBe("low");
  });

  it("reads applied thought level from set response currentValue when returned", async () => {
    const { proc } = createMockProcess({
      configOptions: THOUGHT_CONFIG_OPTIONS,
      setReturnsConfigOptions: true,
    });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
    });
    client.reasoningEffort = "low";

    const result = await client.generateCompletion({
      ...singleUserTurn({ system: "s", user: "u" }),
    });

    expect(result.content).toBe("This is the answer.");
  });

  it("probes capabilities for a specific model by selecting it first", async () => {
    const { proc } = createMockProcess({
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "model-fast",
          options: [{ value: "model-fast" }, { value: "model-pro" }],
        },
        {
          id: "thought_level",
          type: "select",
          currentValue: "high",
          options: ["low", "medium", "high"],
        },
      ],
      setReturnsConfigOptions: true,
    });
    mockSpawn.mockReturnValue(proc);

    const probe = await probeAntigravity(TEST_PROFILE, "model-pro");
    expect(probe.modelOptions?.models).toHaveLength(2);
    expect(probe.thoughtLevelOptions?.choices).toEqual([
      "low",
      "medium",
      "high",
    ]);
    const setCalls = sentMessages(proc.stdin.write).filter(
      (m) => m.method === "session/set_config_option",
    );
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].params).toEqual({
      sessionId: "test-session-123",
      configId: "model",
      value: "model-pro",
    });
  });

  describe("background job unattended ceiling enforcement", () => {
    it("preserves saved provider default on unattended jobs that omit reasoning without policy cap", async () => {
      const { proc } = createMockProcess({
        configOptions: THOUGHT_CONFIG_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({
        profile: TEST_PROFILE,
      });
      client.reasoningEffort = "high";

      // Normal unattended job (e.g. status card or retry) that omits reasoning
      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        unattended: true,
      });

      const setCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/set_config_option",
      );
      // Saved high is provider default; ACP config options currently has currentValue high, so no redundant set call
      expect(setCalls).toHaveLength(0);
      expect(result.reasoning?.downgradedTo).toBeUndefined();
    });

    it("clamps to low when background job carries policy cap off (admin off or frugal)", async () => {
      const { proc } = createMockProcess({
        configOptions: THOUGHT_CONFIG_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({
        profile: TEST_PROFILE,
      });
      client.reasoningEffort = "high";

      // Deliberate policy off (e.g. admin disabled or frugal usage)
      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: { effort: "off", summaries: false, maxEffort: "off" },
        unattended: true,
      });

      const setCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/set_config_option",
      );
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].params).toEqual({
        sessionId: "test-session-123",
        configId: "thought_level",
        value: "low",
      });
      expect(result.reasoning?.downgradedTo).toBe("low");
    });

    it("clamps saved high to low when background job carries maxEffort low", async () => {
      const { proc } = createMockProcess({
        configOptions: THOUGHT_CONFIG_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({
        profile: TEST_PROFILE,
      });
      client.reasoningEffort = "high";

      // Background job with admin cap low
      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: { effort: "low", summaries: false, maxEffort: "low" },
        unattended: true,
      });

      const setCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/set_config_option",
      );
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].params).toEqual({
        sessionId: "test-session-123",
        configId: "thought_level",
        value: "low",
      });
      expect(result.reasoning?.downgradedTo).toBe("low");
    });

    it("clamps saved high to medium when background job carries maxEffort medium", async () => {
      const { proc } = createMockProcess({
        configOptions: THOUGHT_CONFIG_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({
        profile: TEST_PROFILE,
      });
      client.reasoningEffort = "high";

      // Background job with admin cap medium
      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: { effort: "medium", summaries: false, maxEffort: "medium" },
        unattended: true,
      });

      const setCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/set_config_option",
      );
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].params).toEqual({
        sessionId: "test-session-123",
        configId: "thought_level",
        value: "medium",
      });
      expect(result.reasoning?.downgradedTo).toBe("medium");
    });
  });

  describe("explicit manual Coach choice vs provider default", () => {
    it("manual low overrides saved high in Coach turn", async () => {
      const { proc } = createMockProcess({
        configOptions: THOUGHT_CONFIG_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({
        profile: TEST_PROFILE,
      });
      client.reasoningEffort = "high";

      const { reasoningForTurn } = await import("../coach/turn/reasoning");
      const turnReasoning = reasoningForTurn("low", "user", undefined, true);
      expect(turnReasoning.effort).toBe("low");
      expect(turnReasoning.explicit).toBe(true);

      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: turnReasoning,
      });

      const setCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/set_config_option",
      );
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].params).toEqual({
        sessionId: "test-session-123",
        configId: "thought_level",
        value: "low",
      });
      expect(result.reasoning?.downgradedTo).toBeUndefined();
    });

    it("manual high overrides saved low in Coach turn", async () => {
      const { proc } = createMockProcess({
        configOptions: THOUGHT_CONFIG_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({
        profile: TEST_PROFILE,
      });
      client.reasoningEffort = "low";

      const { reasoningForTurn } = await import("../coach/turn/reasoning");
      const turnReasoning = reasoningForTurn("high", "user", undefined, true);
      expect(turnReasoning.effort).toBe("high");
      expect(turnReasoning.explicit).toBe(true);

      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: turnReasoning,
      });

      // Initially mock has currentValue: "high", so selecting high requires no set call
      const setCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/set_config_option",
      );
      expect(setCalls).toHaveLength(0);
      expect(result.reasoning?.downgradedTo).toBeUndefined();
    });

    it("manual medium overrides saved high in Coach turn", async () => {
      const { proc } = createMockProcess({
        configOptions: THOUGHT_CONFIG_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({
        profile: TEST_PROFILE,
      });
      client.reasoningEffort = "high";

      const { reasoningForTurn } = await import("../coach/turn/reasoning");
      const turnReasoning = reasoningForTurn("medium", "user", undefined, true);
      expect(turnReasoning.effort).toBe("medium");
      expect(turnReasoning.explicit).toBe(true);

      await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: turnReasoning,
      });

      const setCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/set_config_option",
      );
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].params).toEqual({
        sessionId: "test-session-123",
        configId: "thought_level",
        value: "medium",
      });
    });

    it("untouched default Coach turn uses saved provider default", async () => {
      const { proc } = createMockProcess({
        configOptions: THOUGHT_CONFIG_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({
        profile: TEST_PROFILE,
      });
      client.reasoningEffort = "low";

      const { reasoningForTurn } = await import("../coach/turn/reasoning");
      // Untouched default (explicit: false) with generic resolved medium
      const turnReasoning = reasoningForTurn(
        "medium",
        "user",
        undefined,
        false,
      );
      expect(turnReasoning.effort).toBe("medium");
      expect(turnReasoning.explicit).toBe(false);

      await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: turnReasoning,
      });

      const setCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/set_config_option",
      );
      // Saved low is honored instead of generic medium
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].params).toEqual({
        sessionId: "test-session-123",
        configId: "thought_level",
        value: "low",
      });
    });
  });
});

describe("resolveTargetThoughtLevel precedence", () => {
  it("maps off/none to low", () => {
    expect(resolveTargetThoughtLevel("off", "high")).toBe("low");
    expect(resolveTargetThoughtLevel("none", "high")).toBe("low");
    expect(resolveTargetThoughtLevel("medium", "none")).toBe("low");
  });

  it("saved provider effort overrides generic Coach default medium", () => {
    expect(resolveTargetThoughtLevel("medium", "low")).toBe("low");
    expect(resolveTargetThoughtLevel("medium", "high")).toBe("high");
  });

  it("honors per-call medium when provider is unconfigured", () => {
    expect(resolveTargetThoughtLevel("medium", null)).toBe("medium");
    expect(resolveTargetThoughtLevel("medium", undefined)).toBe("medium");
  });

  it("explicit non-default call effort applies when provider is unconfigured", () => {
    expect(resolveTargetThoughtLevel("low", null)).toBe("low");
    expect(resolveTargetThoughtLevel("high", null)).toBe("high");
  });

  it("enforces administrative reasoning cap against saved effort and defaults", () => {
    // Saved high clamped to medium by maxEffort
    expect(resolveTargetThoughtLevel("medium", "high", "medium")).toBe(
      "medium",
    );
    // Saved high clamped to low by maxEffort
    expect(resolveTargetThoughtLevel("medium", "high", "low")).toBe("low");
    // Unconfigured medium with cap medium remains medium
    expect(resolveTargetThoughtLevel("medium", null, "medium")).toBe("medium");
    expect(resolveTargetThoughtLevel("medium", null, "low")).toBe("low");
    // Unconfigured high with cap medium clamps to medium
    expect(resolveTargetThoughtLevel("high", null, "medium")).toBe("medium");
    // Explicit off still maps to low regardless of cap
    expect(resolveTargetThoughtLevel("off", "high", "high")).toBe("low");
    // Administrative cap off maps to low (honoring offIsReal: false)
    expect(resolveTargetThoughtLevel("medium", "high", "off")).toBe("low");
    expect(resolveTargetThoughtLevel("medium", null, "off")).toBe("low");
  });

  it("handles unattended background jobs when admin is disabled or frugal (reasoning omitted/off)", () => {
    // Unattended with saved high and deliberate policy cap off
    expect(resolveTargetThoughtLevel("off", "high", "off", false)).toBe("low");
    expect(resolveTargetThoughtLevel(undefined, "high", "off", false)).toBe(
      "low",
    );

    // Unattended without reasoning and without policy cap keeps saved provider default
    expect(resolveTargetThoughtLevel(undefined, "high", undefined, false)).toBe(
      "high",
    );

    // Unattended with saved high and admin capped at low
    expect(resolveTargetThoughtLevel("low", "high", "low", false)).toBe("low");

    // Unattended with saved high and admin capped at medium
    expect(resolveTargetThoughtLevel("medium", "high", "medium", false)).toBe(
      "medium",
    );

    // Manual Coach selection overrides provider default
    expect(resolveTargetThoughtLevel("low", "high", undefined, true)).toBe(
      "low",
    );
    expect(resolveTargetThoughtLevel("high", "low", undefined, true)).toBe(
      "high",
    );
    expect(resolveTargetThoughtLevel("medium", "high", undefined, true)).toBe(
      "medium",
    );
  });
});

describe("end-to-end background job reasoning resolution through runner into AntigravityClient", () => {
  beforeEach(() => {
    dbState.adminSettings = null;
    dbState.userLevel = null;
    dbState.failAdmin = false;
    dbState.failUser = false;
  });

  it("clamps saved high to low when admin is disabled or record usage level is frugal, but preserves saved high on unrequested calls", async () => {
    const { resolveJobReasoning } = await import("../reasoning/controls");
    const { runRawCompletionWithFallback } = await import("../provider-runner");

    const THOUGHT_CONFIG_OPTIONS = [
      MODEL_OPTION,
      {
        id: "thought_level",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ];

    const spawnedProcs: ReturnType<typeof createMockProcess>[] = [];
    const mockSpawn = spawn as ReturnType<typeof vi.fn>;
    mockSpawn.mockImplementation(() => {
      const mock = createMockProcess({
        configOptions: JSON.parse(JSON.stringify(THOUGHT_CONFIG_OPTIONS)),
      });
      spawnedProcs.push(mock);
      return mock.proc;
    });
    const client = new AntigravityClient({ profile: TEST_PROFILE });
    client.reasoningEffort = "high";

    const agyChain = [{ providerType: "antigravity" as const }];

    // 1. Admin reasoning disabled
    dbState.adminSettings = { aiReasoningEnabled: false };
    const adminDisabledReasoning = await resolveJobReasoning(
      "daily_briefing",
      agyChain,
      "u1",
    );
    expect(adminDisabledReasoning).toEqual({
      effort: "off",
      summaries: false,
      maxEffort: "off",
    });

    const run1 = await runRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: [{ providerType: "antigravity", instance: client }],
      params: {
        ...singleUserTurn({ system: "sys", user: "usr" }),
        ...(adminDisabledReasoning
          ? { reasoning: adminDisabledReasoning }
          : {}),
      },
    });

    expect(run1.result.reasoning).toMatchObject({
      downgradedTo: "low",
    });
    const setCalls1 = sentMessages(spawnedProcs[0].proc.stdin.write).filter(
      (m) =>
        m.method === "session/set_config_option" &&
        (m.params as any)?.configId === "thought_level",
    );
    expect(setCalls1.at(-1)?.params?.value).toBe("low");

    // 2. Frugal AI usage level
    dbState.adminSettings = { aiReasoningEnabled: true };
    dbState.userLevel = "FRUGAL";
    const frugalReasoning = await resolveJobReasoning(
      "daily_briefing",
      agyChain,
      "u1",
    );
    expect(frugalReasoning).toEqual({
      effort: "off",
      summaries: false,
      maxEffort: "off",
    });

    const run2 = await runRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: [{ providerType: "antigravity", instance: client }],
      params: {
        ...singleUserTurn({ system: "sys", user: "usr" }),
        ...(frugalReasoning ? { reasoning: frugalReasoning } : {}),
      },
    });

    expect(run2.result.reasoning).toMatchObject({
      downgradedTo: "low",
    });
    const setCalls2 = sentMessages(spawnedProcs[1].proc.stdin.write).filter(
      (m) =>
        m.method === "session/set_config_option" &&
        (m.params as any)?.configId === "thought_level",
    );
    expect(setCalls2.at(-1)?.params?.value).toBe("low");

    // 3. Paired normal no-reasoning unattended job (omitted reasoning) retains saved high
    dbState.userLevel = "FULL";
    const run3 = await runRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: [{ providerType: "antigravity", instance: client }],
      params: {
        ...singleUserTurn({ system: "sys", user: "usr" }),
      },
    });

    expect(run3.result.reasoning).toBeUndefined();

    // 4. Fallback to non-antigravity provider preserves non-agy wire (reasoning stripped)
    const failingAgy = new AntigravityClient({ profile: TEST_PROFILE });
    vi.spyOn(failingAgy, "generateCompletion").mockRejectedValueOnce(
      Object.assign(new Error("Agy network failure"), { httpStatus: 500 }),
    );
    const mockOpenAi = {
      providerType: "openai" as const,
      generateCompletion: vi.fn(async (_params: any) => ({
        content: "OpenAI fallback reply",
        tokensUsed: 15,
      })),
    };

    await runRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: [
        { providerType: "antigravity", instance: failingAgy },
        { providerType: "openai", instance: mockOpenAi as any },
      ],
      params: {
        ...singleUserTurn({ system: "sys", user: "usr" }),
        ...(frugalReasoning ? { reasoning: frugalReasoning } : {}),
      },
    });

    expect(mockOpenAi.generateCompletion).toHaveBeenCalledTimes(1);
    const openAiParams = mockOpenAi.generateCompletion.mock.calls[0][0];
    expect(openAiParams.unattended).toBe(true);
    expect(openAiParams.reasoning).toBeUndefined();
  });

  it("fails closed to explicit off on real lookup/DB failures during resolveJobReasoning into runner, while unrequested missing/no-job calls retain provider default", async () => {
    const { resolveJobReasoning } = await import("../reasoning/controls");
    const { runRawCompletionWithFallback } = await import("../provider-runner");

    const THOUGHT_CONFIG_OPTIONS = [
      MODEL_OPTION,
      {
        id: "thought_level",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ];

    const spawnedProcs: ReturnType<typeof createMockProcess>[] = [];
    const mockSpawn = spawn as ReturnType<typeof vi.fn>;
    mockSpawn.mockImplementation(() => {
      const mock = createMockProcess({
        configOptions: JSON.parse(JSON.stringify(THOUGHT_CONFIG_OPTIONS)),
      });
      spawnedProcs.push(mock);
      return mock.proc;
    });
    const client = new AntigravityClient({ profile: TEST_PROFILE });
    client.reasoningEffort = "high";

    const agyChain = [{ providerType: "antigravity" as const }];

    // 1. DB failure during usage level lookup (loadRecordUsageLevel throws)
    dbState.failUser = true;
    const usageErrReasoning = await resolveJobReasoning(
      "daily_briefing",
      agyChain,
      "u1",
    );
    expect(usageErrReasoning).toEqual({
      effort: "off",
      summaries: false,
      maxEffort: "off",
    });

    const run1 = await runRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: [{ providerType: "antigravity", instance: client }],
      params: {
        ...singleUserTurn({ system: "sys", user: "usr" }),
        ...(usageErrReasoning ? { reasoning: usageErrReasoning } : {}),
      },
    });

    expect(run1.result.reasoning).toMatchObject({
      downgradedTo: "low",
    });
    const setCalls1 = sentMessages(spawnedProcs[0].proc.stdin.write).filter(
      (m) =>
        m.method === "session/set_config_option" &&
        (m.params as any)?.configId === "thought_level",
    );
    expect(setCalls1.at(-1)?.params?.value).toBe("low");

    // 2. DB failure during admin settings lookup (loadReasoningControls fails closed)
    dbState.failUser = false;
    dbState.failAdmin = true;
    const adminErrReasoning = await resolveJobReasoning(
      "daily_briefing",
      agyChain,
      "u1",
    );
    expect(adminErrReasoning).toEqual({
      effort: "off",
      summaries: false,
      maxEffort: "off",
    });

    const run2 = await runRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: [{ providerType: "antigravity", instance: client }],
      params: {
        ...singleUserTurn({ system: "sys", user: "usr" }),
        ...(adminErrReasoning ? { reasoning: adminErrReasoning } : {}),
      },
    });

    expect(run2.result.reasoning).toMatchObject({
      downgradedTo: "low",
    });
    const setCalls2 = sentMessages(spawnedProcs[1].proc.stdin.write).filter(
      (m) =>
        m.method === "session/set_config_option" &&
        (m.params as any)?.configId === "thought_level",
    );
    expect(setCalls2.at(-1)?.params?.value).toBe("low");

    // 3. Non-Antigravity chain receives undefined on lookup failure
    expect(
      await resolveJobReasoning(
        "daily_briefing",
        [{ providerType: "openai" as const }],
        "u1",
      ),
    ).toBeUndefined();

    // 4. Missing/no-job normal call (unrequested) retains saved high
    dbState.failAdmin = false;
    dbState.failUser = false;
    const run3 = await runRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: [{ providerType: "antigravity", instance: client }],
      params: {
        ...singleUserTurn({ system: "sys", user: "usr" }),
      },
    });

    expect(run3.result.reasoning).toBeUndefined();

    // 5. Failure during normalizeCandidateParams lookup fails closed to off cap
    dbState.failAdmin = true;
    dbState.failUser = true;
    const run4 = await runRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: [{ providerType: "antigravity", instance: client }],
      params: {
        ...singleUserTurn({ system: "sys", user: "usr" }),
      },
    });

    expect(run4.result.reasoning).toMatchObject({
      downgradedTo: "low",
    });
    dbState.failAdmin = false;
    dbState.failUser = false;
  });

  it("enforces admin off/frugal/low cap on omitted-job/status calls with saved high, and preserves saved high on normal allowed policy (buffered and streaming)", async () => {
    const {
      runRawCompletionWithFallback,
      runStreamingRawCompletionWithFallback,
    } = await import("../provider-runner");

    const THOUGHT_CONFIG_OPTIONS = [
      MODEL_OPTION,
      {
        id: "thought_level",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ];

    const spawnedProcs: ReturnType<typeof createMockProcess>[] = [];
    const mockSpawn = spawn as ReturnType<typeof vi.fn>;
    mockSpawn.mockImplementation(() => {
      const mock = createMockProcess({
        configOptions: JSON.parse(JSON.stringify(THOUGHT_CONFIG_OPTIONS)),
      });
      spawnedProcs.push(mock);
      return mock.proc;
    });
    const client = new AntigravityClient({ profile: TEST_PROFILE });
    client.reasoningEffort = "high";

    const agyProvider = [
      { providerType: "antigravity" as const, instance: client },
    ];

    // 1. Status call (omitted reasoning) with admin disabled clamps saved high to low
    dbState.adminSettings = { aiReasoningEnabled: false };
    const runAdminOff = await runRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: agyProvider,
      params: singleUserTurn({ system: "s", user: "u" }), // NO reasoning property
    });
    expect(runAdminOff.result.reasoning).toMatchObject({
      downgradedTo: "low",
    });
    const setCalls1 = sentMessages(spawnedProcs[0].proc.stdin.write).filter(
      (m) =>
        m.method === "session/set_config_option" &&
        (m.params as any)?.configId === "thought_level",
    );
    expect(setCalls1.at(-1)?.params?.value).toBe("low");

    // 2. Status call (omitted reasoning) on frugal AI usage level clamps saved high to low
    dbState.adminSettings = {
      aiReasoningEnabled: true,
      aiReasoningMaxEffort: "high",
    };
    dbState.userLevel = "FRUGAL";
    const runFrugal = await runRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: agyProvider,
      params: singleUserTurn({ system: "s", user: "u" }),
    });
    expect(runFrugal.result.reasoning).toMatchObject({
      downgradedTo: "low",
    });
    const setCalls2 = sentMessages(spawnedProcs[1].proc.stdin.write).filter(
      (m) =>
        m.method === "session/set_config_option" &&
        (m.params as any)?.configId === "thought_level",
    );
    expect(setCalls2.at(-1)?.params?.value).toBe("low");

    // 3. Status call (omitted reasoning) with admin cap low clamps saved high to low
    dbState.adminSettings = {
      aiReasoningEnabled: true,
      aiReasoningMaxEffort: "low",
    };
    dbState.userLevel = "FULL";
    const runAdminLow = await runRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: agyProvider,
      params: singleUserTurn({ system: "s", user: "u" }),
    });
    expect(runAdminLow.result.reasoning).toMatchObject({
      downgradedTo: "low",
    });
    const setCalls3 = sentMessages(spawnedProcs[2].proc.stdin.write).filter(
      (m) =>
        m.method === "session/set_config_option" &&
        (m.params as any)?.configId === "thought_level",
    );
    expect(setCalls3.at(-1)?.params?.value).toBe("low");

    // 4. Normal omitted status call with allowed policy preserves saved high without downgrade
    dbState.adminSettings = {
      aiReasoningEnabled: true,
      aiReasoningMaxEffort: "high",
    };
    dbState.userLevel = "FULL";
    const runNormal = await runRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: agyProvider,
      params: singleUserTurn({ system: "s", user: "u" }),
    });
    expect(runNormal.result.reasoning).toBeUndefined();

    // 5. Streaming runner also clamps omitted reasoning call when admin is disabled
    dbState.adminSettings = { aiReasoningEnabled: false };
    const streamRun = await runStreamingRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: agyProvider,
      params: singleUserTurn({ system: "s", user: "u" }),
      onDelta: vi.fn(),
    });
    expect(streamRun.result.reasoning).toMatchObject({
      downgradedTo: "low",
    });

    // 6. Fallback hop to non-Antigravity provider preserves clean wire (reasoning undefined)
    const failingAgy = new AntigravityClient({ profile: TEST_PROFILE });
    vi.spyOn(failingAgy, "generateCompletion").mockRejectedValueOnce(
      Object.assign(new Error("Agy failure"), { httpStatus: 500 }),
    );
    const mockOpenAi = {
      providerType: "openai" as const,
      generateCompletion: vi.fn(async (_params: any) => ({
        content: "OpenAI reply",
        tokensUsed: 10,
      })),
    };

    dbState.adminSettings = { aiReasoningEnabled: false };
    await runRawCompletionWithFallback({
      userId: "u1",
      surface: "job",
      providers: [
        { providerType: "antigravity", instance: failingAgy },
        { providerType: "openai", instance: mockOpenAi as any },
      ],
      params: singleUserTurn({ system: "s", user: "u" }), // omitted reasoning
    });

    expect(mockOpenAi.generateCompletion).toHaveBeenCalledTimes(1);
    const openAiParams = mockOpenAi.generateCompletion.mock.calls[0][0];
    expect(openAiParams.unattended).toBe(true);
    expect(openAiParams.reasoning).toBeUndefined();
  });

  describe("policy cap and advertised choices enforcement", () => {
    let mockSpawn: ReturnType<typeof vi.fn>;

    const FULL_THOUGHT_OPTIONS = [
      MODEL_OPTION,
      {
        id: "thought_level",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ];

    const MEDIUM_HIGH_OPTIONS = [
      MODEL_OPTION,
      {
        id: "thought_level",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ];

    beforeEach(() => {
      mockSpawn = spawn as ReturnType<typeof vi.fn>;
    });

    it("fails closed before prompt when mandatory cap is low and choices are only [medium, high]", async () => {
      const { proc } = createMockProcess({
        configOptions: MEDIUM_HIGH_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });

      await expect(
        client.generateCompletion({
          ...singleUserTurn({ system: "s", user: "u" }),
          reasoning: { effort: "high", summaries: false, maxEffort: "low" },
        }),
      ).rejects.toThrow("Antigravity thought level could not be selected");

      const methods = sentMessages(proc.stdin.write).map((m) => m.method);
      expect(methods).not.toContain("session/prompt");
    });

    it("fails closed before prompt when saved client policyCap is low and choices are only [medium, high]", async () => {
      const { proc } = createMockProcess({
        configOptions: MEDIUM_HIGH_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      client.policyCap = "low";

      await expect(
        client.generateCompletion({
          ...singleUserTurn({ system: "s", user: "u" }),
          reasoning: { effort: "high", summaries: false },
        }),
      ).rejects.toThrow("Antigravity thought level could not be selected");

      const methods = sentMessages(proc.stdin.write).map((m) => m.method);
      expect(methods).not.toContain("session/prompt");
    });

    it("fails closed before prompt when policy cap is off and choices are only [medium, high]", async () => {
      const { proc } = createMockProcess({
        configOptions: MEDIUM_HIGH_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });

      await expect(
        client.generateCompletion({
          ...singleUserTurn({ system: "s", user: "u" }),
          reasoning: { effort: "off", summaries: false, maxEffort: "off" },
        }),
      ).rejects.toThrow("Antigravity thought level could not be selected");

      const methods = sentMessages(proc.stdin.write).map((m) => m.method);
      expect(methods).not.toContain("session/prompt");
    });

    it("enforces stricter client policyCap when caller passes looser maxEffort (caller cannot bypass admin cap)", async () => {
      const { proc } = createMockProcess({
        configOptions: MEDIUM_HIGH_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      client.policyCap = "low";

      // Caller attempts to pass looser maxEffort: "high" while client policyCap is "low":
      // Stricter policyCap "low" must be enforced and fail closed before prompt on [medium, high]
      await expect(
        client.generateCompletion({
          ...singleUserTurn({ system: "s", user: "u" }),
          reasoning: { effort: "high", summaries: false, maxEffort: "high" },
        }),
      ).rejects.toThrow("Antigravity thought level could not be selected");

      const methods = sentMessages(proc.stdin.write).map((m) => m.method);
      expect(methods).not.toContain("session/prompt");
    });

    it("enforces stricter caller maxEffort when client policyCap is looser", async () => {
      const { proc } = createMockProcess({
        configOptions: FULL_THOUGHT_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      client.policyCap = "high";

      // Caller passes stricter maxEffort: "low" while client policyCap is "high":
      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: { effort: "high", summaries: false, maxEffort: "low" },
      });

      const setCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/set_config_option",
      );
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].params).toEqual({
        sessionId: "test-session-123",
        configId: "thought_level",
        value: "low",
      });
      expect(result.reasoning?.downgradedTo).toBe("low");
    });

    it("falls back to compatible lower level when target is unavailable at/below medium cap", async () => {
      const LOW_HIGH_OPTIONS = [
        MODEL_OPTION,
        {
          id: "thought_level",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ];
      const { proc } = createMockProcess({ configOptions: LOW_HIGH_OPTIONS });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });

      // Target high capped to medium, but medium is unavailable: falls back to compatible low
      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: { effort: "high", summaries: false, maxEffort: "medium" },
      });

      const setCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/set_config_option",
      );
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].params).toEqual({
        sessionId: "test-session-123",
        configId: "thought_level",
        value: "low",
      });
      const promptCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/prompt",
      );
      expect(promptCalls).toHaveLength(1);
      expect(result.reasoning?.downgradedTo).toBe("low");
    });

    it("falls back to compatible medium level when high target unavailable with medium cap", async () => {
      const MEDIUM_ONLY_OPTIONS = [
        MODEL_OPTION,
        {
          id: "thought_level",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [{ value: "medium", name: "Medium" }],
        },
      ];
      const { proc } = createMockProcess({
        configOptions: MEDIUM_ONLY_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });

      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: { effort: "high", summaries: false, maxEffort: "medium" },
      });

      const promptCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/prompt",
      );
      expect(promptCalls).toHaveLength(1);
      expect(result.reasoning?.downgradedTo).toBe("medium");
    });

    it("does not report downgrade when uncapped unsupported preference runs at current level", async () => {
      const HIGH_ONLY_OPTIONS = [
        MODEL_OPTION,
        {
          id: "thought_level",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [{ value: "high", name: "High" }],
        },
      ];
      const { proc } = createMockProcess({ configOptions: HIGH_ONLY_OPTIONS });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });

      // Uncapped request for "low" when only "high" is available: runs at "high", sends prompt,
      // but must NOT report a fake downgrade to "high".
      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: { effort: "low", summaries: false },
      });

      const promptCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/prompt",
      );
      expect(promptCalls).toHaveLength(1);
      expect(result.reasoning?.downgradedTo).toBeUndefined();
    });

    it("reports downgrade for omitted-request when cap clamps default high to medium", async () => {
      const { proc } = createMockProcess({
        configOptions: FULL_THOUGHT_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      client.policyCap = "medium";

      // Omitted reasoning params with saved client policyCap "medium":
      // Clamps default "high" to "medium" and reports downgradedTo: "medium"
      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
      });

      const setCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/set_config_option",
      );
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].params).toEqual({
        sessionId: "test-session-123",
        configId: "thought_level",
        value: "medium",
      });
      expect(result.reasoning?.downgradedTo).toBe("medium");
    });

    it("preserves supported behavior without failure for models with no thought selector", async () => {
      // DEFAULT_CONFIG_OPTIONS has no thought selector
      const { proc } = createMockProcess({
        configOptions: DEFAULT_CONFIG_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      client.policyCap = "low";

      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: { effort: "high", summaries: false, maxEffort: "low" },
      });

      const methods = sentMessages(proc.stdin.write).map((m) => m.method);
      expect(methods).not.toContain("session/set_config_option");
      expect(methods.filter((m) => m === "session/prompt")).toHaveLength(1);
      expect(result.content).toBe("This is the answer.");
      expect(result.reasoning?.downgradedTo).toBeUndefined();
    });

    it("handles full 3 choices correctly when setting each level", async () => {
      const { proc } = createMockProcess({
        configOptions: FULL_THOUGHT_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });

      // Requesting low when current is high sends set_config_option
      const resultLow = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: { effort: "low", summaries: false, explicit: true },
      });
      expect(resultLow.content).toBe("This is the answer.");

      const setCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/set_config_option",
      );
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].params).toEqual({
        sessionId: "test-session-123",
        configId: "thought_level",
        value: "low",
      });
    });

    it("fails closed before prompt when model switch returns empty configOptions under restrictive cap", async () => {
      const { proc } = createMockProcess({
        configOptions: FULL_THOUGHT_OPTIONS,
        setReturnsConfigOptions: false,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({
        profile: TEST_PROFILE,
        model: "model-pro", // model-pro triggers selectModel
      });
      client.policyCap = "low";

      await expect(
        client.generateCompletion({
          ...singleUserTurn({ system: "s", user: "u" }),
        }),
      ).rejects.toThrow("Antigravity thought level could not be selected");

      const methods = sentMessages(proc.stdin.write).map((m) => m.method);
      expect(methods).not.toContain("session/prompt");
    });

    it("fails closed before prompt when thought level setter returns empty ack under cap", async () => {
      const { proc } = createMockProcess({
        configOptions: FULL_THOUGHT_OPTIONS,
        setReturnsConfigOptions: false,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      client.policyCap = "low";

      await expect(
        client.generateCompletion({
          ...singleUserTurn({ system: "s", user: "u" }),
          reasoning: { effort: "low", summaries: false },
        }),
      ).rejects.toThrow("Antigravity thought level could not be selected");

      const methods = sentMessages(proc.stdin.write).map((m) => m.method);
      expect(methods).not.toContain("session/prompt");
    });

    it("fails closed before prompt when thought level setter acknowledges unchanged high under cap", async () => {
      const { proc } = createMockProcess({
        configOptions: FULL_THOUGHT_OPTIONS,
        setReturnsStaleConfig: true,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      client.policyCap = "low";

      await expect(
        client.generateCompletion({
          ...singleUserTurn({ system: "s", user: "u" }),
          reasoning: { effort: "low", summaries: false },
        }),
      ).rejects.toThrow("Antigravity thought level could not be selected");

      const methods = sentMessages(proc.stdin.write).map((m) => m.method);
      expect(methods).not.toContain("session/prompt");
    });

    it("reports actual downgrade when omitted-request falls back below medium cap to low", async () => {
      const LOW_HIGH_OPTIONS = [
        MODEL_OPTION,
        {
          id: "thought_level",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ];
      const { proc } = createMockProcess({ configOptions: LOW_HIGH_OPTIONS });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      client.policyCap = "medium";

      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
      });

      const setCalls = sentMessages(proc.stdin.write).filter(
        (m) => m.method === "session/set_config_option",
      );
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].params).toEqual({
        sessionId: "test-session-123",
        configId: "thought_level",
        value: "low",
      });
      expect(result.reasoning?.downgradedTo).toBe("low");
    });

    it("never reports unknown level as downgradedTo", async () => {
      const UNKNOWN_LEVEL_OPTIONS = [
        MODEL_OPTION,
        {
          id: "thought_level",
          category: "thought_level",
          type: "select",
          currentValue: "max",
          options: [{ value: "max", name: "Max" }],
        },
      ];
      const { proc } = createMockProcess({
        configOptions: UNKNOWN_LEVEL_OPTIONS,
      });
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });

      const result = await client.generateCompletion({
        ...singleUserTurn({ system: "s", user: "u" }),
        reasoning: { effort: "low", summaries: false },
      });

      expect(result.reasoning?.downgradedTo).toBeUndefined();
    });
  });
});
