import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AntigravityClient } from "../antigravity-client";
import type { CompletionParams } from "../types";
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
/**
 * Creates a mock ACP process that responds to initialize, session/new,
 * and session/prompt with configurable capabilities.
 */
function createMockProcess({
  spawnEvent = true,
  promptCapabilities = { image: true, embeddedContext: true },
}: {
  spawnEvent?: boolean;
  promptCapabilities?: { image?: boolean; embeddedContext?: boolean };
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
          agentInfo: { name: "Test Antigravity Agent" },
          agentCapabilities: {
            promptCapabilities,
          },
        },
      });
    } else if (msg.method === "session/new") {
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: { sessionId: "test-session-id" },
      });
    } else if (msg.method === "session/prompt") {
      // Send agent_message_chunk updates
      sendMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Processing image..." },
          },
        },
      });
      // Send another chunk
      sendMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: " Done." },
          },
        },
      });
      // Complete the prompt
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "stop" },
      });
    }
  }
  return proc;
}
const TEST_PROFILE = {
  geminiDir: "/var/lib/healthlog/antigravity/user-1",
};
describe("AntigravityClient multimodal support", () => {
  let client: AntigravityClient;
  let mockSpawn: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    client = new AntigravityClient({ profile: TEST_PROFILE });
    mockSpawn = spawn as ReturnType<typeof vi.fn>;
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  describe("image support", () => {
    it("accepts image content blocks when promptCapabilities.image is true", async () => {
      const mockProc = createMockProcess({
        promptCapabilities: { image: true, embeddedContext: true },
      });
      mockSpawn.mockReturnValue(mockProc);
      const params: CompletionParams = {
        system: "Describe the attachments.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze this image" },
              {
                type: "image",
                mediaType: "image/png",
                dataBase64:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
              },
            ],
          },
        ],
      };
      const result = await client.generateCompletion(params);
      expect(result.content).toBe("Processing image... Done.");
      expect(result.providerType).toBe("antigravity");
      expect(result.model).toBe("antigravity");
    });
    it("rejects image content blocks when promptCapabilities.image is false", async () => {
      const mockProc = createMockProcess({
        promptCapabilities: { image: false, embeddedContext: true },
      });
      mockSpawn.mockReturnValue(mockProc);
      const params: CompletionParams = {
        system: "Describe the attachments.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze this image" },
              {
                type: "image",
                mediaType: "image/png",
                dataBase64:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
              },
            ],
          },
        ],
      };
      await expect(client.generateCompletion(params)).rejects.toThrow(
        "Antigravity does not accept image input",
      );
    });
    it("supports JPEG and WebP image formats", async () => {
      const mockProc = createMockProcess({
        promptCapabilities: { image: true, embeddedContext: true },
      });
      mockSpawn.mockReturnValue(mockProc);
      const jpegParams: CompletionParams = {
        system: "Describe the attachments.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                mediaType: "image/jpeg",
                dataBase64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD",
              },
            ],
          },
        ],
      };
      const result = await client.generateCompletion(jpegParams);
      expect(result.providerType).toBe("antigravity");
      // Test WebP
      mockSpawn.mockClear();
      mockSpawn.mockReturnValue(
        createMockProcess({
          promptCapabilities: { image: true, embeddedContext: true },
        }),
      );
      const webpParams: CompletionParams = {
        system: "Describe the attachments.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                mediaType: "image/webp",
                dataBase64: "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAI",
              },
            ],
          },
        ],
      };
      const result2 = await client.generateCompletion(webpParams);
      expect(result2.providerType).toBe("antigravity");
    });
  });
  describe("PDF support", () => {
    it("accepts PDF document blocks when promptCapabilities.embeddedContext is true", async () => {
      const mockProc = createMockProcess({
        promptCapabilities: { image: true, embeddedContext: true },
      });
      mockSpawn.mockReturnValue(mockProc);
      const params: CompletionParams = {
        system: "Describe the attachments.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze this document" },
              {
                type: "document",
                mediaType: "application/pdf",
                dataBase64:
                  "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZw==",
              },
            ],
          },
        ],
      };
      const result = await client.generateCompletion(params);
      expect(result.content).toBe("Processing image... Done.");
      expect(result.providerType).toBe("antigravity");
    });
    it("rejects PDF document blocks when promptCapabilities.embeddedContext is false", async () => {
      const mockProc = createMockProcess({
        promptCapabilities: { image: true, embeddedContext: false },
      });
      mockSpawn.mockReturnValue(mockProc);
      const params: CompletionParams = {
        system: "Describe the attachments.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                mediaType: "application/pdf",
                dataBase64:
                  "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZw==",
              },
            ],
          },
        ],
      };
      await expect(client.generateCompletion(params)).rejects.toThrow(
        "Antigravity does not accept PDF input",
      );
    });
    it("handles multi-page PDF documents", async () => {
      const mockProc = createMockProcess({
        promptCapabilities: { image: true, embeddedContext: true },
      });
      mockSpawn.mockReturnValue(mockProc);
      // Larger base64 representing a multi-page PDF (synthetic)
      const multiPagePdf =
        "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFszIDAgUiA0IDAgUl0KL0NvdW50IDIKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCj4+CmVuZG9iagp4cmVmCjAgNQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA3NCAwMDAwMCBuIAowMDAwMDAwMTczIDAwMDAwIG4gCjAwMDAwMDAyMzAgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA1Ci9Sb290IDEgMCBSCj4+CnN0YXJ0eHJlZgoyODUKJSVFT0Y=";
      const params: CompletionParams = {
        system: "Describe the attachments.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                mediaType: "application/pdf",
                dataBase64: multiPagePdf,
              },
            ],
          },
        ],
      };
      const result = await client.generateCompletion(params);
      expect(result.providerType).toBe("antigravity");
    });
  });
  describe("combined text + media", () => {
    it("handles text + image in same message", async () => {
      const mockProc = createMockProcess({
        promptCapabilities: { image: true, embeddedContext: true },
      });
      mockSpawn.mockReturnValue(mockProc);
      const params: CompletionParams = {
        system: "Describe the attachments.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Please analyze this laboratory result:" },
              {
                type: "image",
                mediaType: "image/png",
                dataBase64:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
              },
            ],
          },
        ],
      };
      const result = await client.generateCompletion(params);
      expect(result.content).toContain("Processing image...");
    });
    it("handles text + PDF in same message", async () => {
      const mockProc = createMockProcess({
        promptCapabilities: { image: true, embeddedContext: true },
      });
      mockSpawn.mockReturnValue(mockProc);
      const params: CompletionParams = {
        system: "Describe the attachments.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Extract biomarkers from this report:" },
              {
                type: "document",
                mediaType: "application/pdf",
                dataBase64:
                  "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZw==",
              },
            ],
          },
        ],
      };
      const result = await client.generateCompletion(params);
      expect(result.providerType).toBe("antigravity");
    });
    it("handles text + image + PDF in same message", async () => {
      const mockProc = createMockProcess({
        promptCapabilities: { image: true, embeddedContext: true },
      });
      mockSpawn.mockReturnValue(mockProc);
      const params: CompletionParams = {
        system: "Describe the attachments.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Compare these two documents:" },
              {
                type: "image",
                mediaType: "image/jpeg",
                dataBase64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD",
              },
              {
                type: "document",
                mediaType: "application/pdf",
                dataBase64:
                  "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZw==",
              },
            ],
          },
        ],
      };
      const result = await client.generateCompletion(params);
      expect(result.providerType).toBe("antigravity");
    });
  });
  describe("capability discovery", () => {
    it("queries promptCapabilities during initialize", async () => {
      const mockProc = createMockProcess({
        promptCapabilities: { image: true, embeddedContext: false },
      });
      mockSpawn.mockReturnValue(mockProc);
      const params: CompletionParams = {
        system: "Describe the attachments.",
        messages: [{ role: "user", content: "Test" }],
      };
      await client.generateCompletion(params);
      // Verify spawn was called
      expect(mockSpawn).toHaveBeenCalled();
    });
    it("handles undefined capabilities gracefully", async () => {
      const handlers: {
        stdout: ((data: Buffer) => void)[];
        stderr: ((data: Buffer) => void)[];
        spawn: (() => void)[];
        exit: ((code: number | null, signal: string | null) => void)[];
      } = { stdout: [], stderr: [], spawn: [], exit: [] };
      let stdinBuffer = "";
      const proc = {
        stdin: {
          on: vi.fn(),
          write: vi.fn((data: string) => {
            stdinBuffer += data;
            const lines = stdinBuffer.split("\n");
            stdinBuffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const msg = JSON.parse(line);
                if (msg.method === "initialize") {
                  sendMessage({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                      agentInfo: { name: "Test Agent" },
                      // capabilities undefined
                    },
                  });
                } else if (msg.method === "session/new") {
                  sendMessage({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: { sessionId: "test-session-id" },
                  });
                } else if (msg.method === "session/prompt") {
                  sendMessage({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: { stopReason: "stop" },
                  });
                }
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
          on: vi.fn(),
          resume: vi.fn(),
        },
        pid: 4242,
        exitCode: null,
        signalCode: null,
        on: vi.fn((event: string, handler: (...args: never[]) => void) => {
          if (event === "exit")
            handlers.exit.push(
              handler as (code: number | null, signal: string | null) => void,
            );
          if (event === "spawn") {
            handlers.spawn.push(handler as () => void);
            setTimeout(() => handlers.spawn.forEach((h) => h()), 0);
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
      mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
      const params: CompletionParams = {
        system: "Describe the attachments.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                mediaType: "image/png",
                dataBase64:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
              },
            ],
          },
        ],
      };
      // With undefined capabilities, image check should default to false
      await expect(client.generateCompletion(params)).rejects.toThrow(
        "Antigravity does not accept image input",
      );
    });
  });
  describe("error handling", () => {
    it("rejects unsupported MIME types before process spawn", async () => {
      const mockProc = createMockProcess({
        promptCapabilities: { image: true, embeddedContext: true },
      });
      mockSpawn.mockReturnValue(mockProc);
      const params: CompletionParams = {
        system: "Describe the attachments.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                mediaType: "image/bmp" as "image/png",
                dataBase64:
                  "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAP8A",
              },
            ],
          },
        ],
      };
      await expect(client.generateCompletion(params)).rejects.toThrow(
        "Unsupported image MIME type: image/bmp",
      );
      // The process must not have been spawned.
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });
});
