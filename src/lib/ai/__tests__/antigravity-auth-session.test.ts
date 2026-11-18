import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startAntigravityLogin,
  submitAntigravityAuthCode,
  cancelAntigravityLogin,
} from "../antigravity-auth-session";
import { spawn } from "child_process";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

describe("antigravity-auth-session", () => {
  const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cancelAntigravityLogin("user-test-1");
  });

  function createMockChild() {
    const stdoutListeners: ((data: Buffer | string) => void)[] = [];
    const stderrListeners: ((data: Buffer | string) => void)[] = [];
    const exitListeners: ((code: number) => void)[] = [];
    const errorListeners: ((err: Error) => void)[] = [];

    let writtenStdin = "";

    const onEvent = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === "exit") exitListeners.push(cb);
      if (event === "error") errorListeners.push(cb);
    });

    const child = {
      stdin: {
        write: vi.fn((data: string) => {
          writtenStdin += data;
        }),
        on: vi.fn(),
      },
      stdout: {
        on: vi.fn((event: string, cb: (data: Buffer | string) => void) => {
          if (event === "data") stdoutListeners.push(cb);
        }),
      },
      stderr: {
        on: vi.fn((event: string, cb: (data: Buffer | string) => void) => {
          if (event === "data") stderrListeners.push(cb);
        }),
      },
      on: onEvent,
      once: onEvent,
      kill: vi.fn(),
      // Null until the process exits, as on a real ChildProcess.
      exitCode: null as number | null,
      signalCode: null as string | null,
    };

    return {
      child,
      emitStdout: (data: string) => stdoutListeners.forEach((l) => l(data)),
      emitStderr: (data: string) => stderrListeners.forEach((l) => l(data)),
      emitExit: (code: number) => exitListeners.forEach((l) => l(code)),
      emitError: (err: Error) => errorListeners.forEach((l) => l(err)),
      getWrittenStdin: () => writtenStdin,
    };
  }

  it("extracts Google auth URL when printed to stdout", async () => {
    const mock = createMockChild();
    mockSpawn.mockReturnValue(mock.child);

    const startPromise = startAntigravityLogin(
      "user-test-1",
      "profile-123",
      "/tmp/profile-123",
    );

    const testUrl =
      "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=123&state=xyz";

    mock.emitStdout("Open this link in a browser to log in with Google:\n\n  ");
    mock.emitStdout(testUrl + "\n\nThen paste the authorization code:");

    const result = await startPromise;
    expect(result.authUrl).toBe(testUrl);
    expect(mockSpawn).toHaveBeenCalledWith(
      "agy",
      ["acp", "--login", "--gemini-dir", "/tmp/profile-123"],
      expect.objectContaining({ cwd: "/tmp/profile-123" }),
    );
  });

  it("rejects when CLI exits before emitting auth URL", async () => {
    const mock = createMockChild();
    mockSpawn.mockReturnValue(mock.child);

    const startPromise = startAntigravityLogin(
      "user-test-1",
      "profile-123",
      "/tmp/profile-123",
    );

    mock.emitStderr("Error: unknown flag\n");
    mock.emitExit(1);

    // The CLI's own output never reaches the caller.
    const error = await startPromise.catch((err: unknown) => err);
    expect(error).toMatchObject({
      name: "AntigravityLoginError",
      failure: "start_failed",
    });
    expect(String((error as Error).message)).not.toContain("unknown flag");
  });

  it("submits authorization code to stdin and handles successful exit", async () => {
    const mock = createMockChild();
    mockSpawn.mockReturnValue(mock.child);

    const startPromise = startAntigravityLogin(
      "user-test-1",
      "profile-123",
      "/tmp/profile-123",
    );

    const testUrl = "https://accounts.google.com/o/oauth2/auth?client_id=abc";
    mock.emitStdout(testUrl);
    await startPromise;

    const submitPromise = submitAntigravityAuthCode(
      "user-test-1",
      "auth-code-456",
    );

    expect(mock.getWrittenStdin()).toBe("auth-code-456\n");

    // Process exits 0 on success
    mock.emitExit(0);

    expect(await submitPromise).toBeNull();
  });

  it("handles token exchange failure on submit", async () => {
    const mock = createMockChild();
    mockSpawn.mockReturnValue(mock.child);

    const startPromise = startAntigravityLogin(
      "user-test-1",
      "profile-123",
      "/tmp/profile-123",
    );

    mock.emitStdout("https://accounts.google.com/o/oauth2/auth?client_id=abc");
    await startPromise;

    const submitPromise = submitAntigravityAuthCode(
      "user-test-1",
      "invalid-code",
    );

    mock.emitStdout(
      'couldn\'t log in: token exchange failed: oauth2: "invalid_grant"\n',
    );
    mock.emitExit(1);

    // A fixed failure code. The CLI's text ("token exchange failed") is not returned.
    expect(await submitPromise).toBe("login_failed");
  });

  it("returns error when submitting without active session", async () => {
    expect(
      await submitAntigravityAuthCode("non-existent-user", "code123"),
    ).toBe("session_expired");
  });

  it("cancels active session and kills process", async () => {
    const mock = createMockChild();
    mockSpawn.mockReturnValue(mock.child);

    startAntigravityLogin("user-test-1", "profile-123", "/tmp/profile-123");

    cancelAntigravityLogin("user-test-1");
    expect(mock.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("sends SIGKILL when the process ignores SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockChild();
      mockSpawn.mockReturnValue(mock.child);
      const startPromise = startAntigravityLogin(
        "user-test-1",
        "profile-123",
        "/tmp/profile-123",
      );
      mock.emitStdout("https://accounts.google.com/o/oauth2/auth?client_id=x");
      await startPromise;

      cancelAntigravityLogin("user-test-1");
      // SIGTERM sets child.killed in Node, which is why the grace timer checks exitCode.
      expect(mock.child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(mock.child.kill).not.toHaveBeenCalledWith("SIGKILL");

      vi.advanceTimersByTime(2_000);
      expect(mock.child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when explicit ANTIGRAVITY_BIN_PATH override fails to resolve", async () => {
    const orig = process.env.ANTIGRAVITY_BIN_PATH;
    process.env.ANTIGRAVITY_BIN_PATH = "/nonexistent/binary";
    try {
      await expect(
        startAntigravityLogin("user-test-1", "profile-123", "/tmp/profile-123"),
      ).rejects.toThrow("Antigravity login could not start");
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      if (orig !== undefined) process.env.ANTIGRAVITY_BIN_PATH = orig;
      else delete process.env.ANTIGRAVITY_BIN_PATH;
    }
  });
});
