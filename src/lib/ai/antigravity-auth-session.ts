/**
 * Manages interactive CLI login sessions for Antigravity (Google OAuth with PKCE).
 *
 * When a user connects Antigravity through the web interface, HealthLog spawns:
 *   agy acp --login --gemini-dir <userGeminiDir>
 *
 * The CLI prints an interactive Google OAuth URL to stdout and pauses on stdin
 * waiting for the user to paste the authorization code or landing page URL.
 *
 * This module keeps track of active login processes in memory, captures the
 * OAuth authorization URL, delivers the pasted code to the process stdin, and
 * ensures processes are cleaned up properly (with a 5-minute timeout).
 *
 * The CLI output is never returned to a caller or written to the log. It can
 * carry paths and account details. Callers get one of the fixed failures in
 * `ANTIGRAVITY_LOGIN_FAILURE_MESSAGES`.
 */
import { spawn, type ChildProcess } from "child_process";
import {
  antigravityChildEnv,
  resolveAntigravityBinary,
} from "./antigravity-bin";
import { envValue } from "@/lib/env";

const GOOGLE_AUTH_URL_REGEX =
  /(https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s]+)/;

const AUTH_SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/** Time the code exchange gets after the code is pasted. */
const CODE_EXCHANGE_TIMEOUT_MS = 45_000;
/** How long a child gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** Output kept while looking for the sign-in link. The link is a few hundred bytes. */
const OUTPUT_TAIL_CHARS = 16 * 1024;

export type AntigravityLoginFailure =
  | "start_failed"
  | "login_failed"
  | "login_timed_out"
  | "session_expired"
  | "empty_code";

/** The message a client sees for each failure. The CLI output is never part of it. */
export const ANTIGRAVITY_LOGIN_FAILURE_MESSAGES: Record<
  AntigravityLoginFailure,
  string
> = {
  start_failed: "Antigravity login could not start",
  login_failed: "Antigravity login failed. Start again and paste the new code.",
  login_timed_out: "Antigravity login timed out. Start again.",
  session_expired: "Login session expired. Start again.",
  empty_code: "Authorization code cannot be empty.",
};

export class AntigravityLoginError extends Error {
  constructor(readonly failure: AntigravityLoginFailure) {
    super(ANTIGRAVITY_LOGIN_FAILURE_MESSAGES[failure]);
    this.name = "AntigravityLoginError";
  }
}

interface ActiveLoginSession {
  child: ChildProcess;
  timeoutId: NodeJS.Timeout;
}

// Module state lives on globalThis. A bundler can load this module once per
// route, and each copy would otherwise hold its own map of login processes.
type LoginRegistry = Map<string, ActiveLoginSession>;
const globalForLogins = globalThis as typeof globalThis & {
  healthlogAntigravityLogins?: LoginRegistry;
};
const activeSessions: LoginRegistry =
  (globalForLogins.healthlogAntigravityLogins ??= new Map());

/**
 * Ask a child to exit. SIGTERM first, SIGKILL after the grace period if it is
 * still running. `exitCode` and `signalCode` stay null until the process has
 * exited. `child.killed` does not, because it turns true as soon as the signal
 * is sent.
 */
function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, KILL_GRACE_MS);
  killTimer.unref();
  child.once("exit", () => clearTimeout(killTimer));
}

/** Remove the user's session from the registry and stop its timer. */
function takeSession(userId: string): ActiveLoginSession | undefined {
  const session = activeSessions.get(userId);
  if (!session) return undefined;
  clearTimeout(session.timeoutId);
  activeSessions.delete(userId);
  return session;
}

/**
 * Cancel and terminate an active login session for the given user, if any.
 */
export function cancelAntigravityLogin(userId: string): void {
  const session = takeSession(userId);
  if (session) stopChild(session.child);
}

/**
 * Start an interactive `agy acp --login` session for a user.
 *
 * Resolves with the Google OAuth authorization URL captured from the output.
 * Rejects with `AntigravityLoginError` when the process fails before it shows
 * the link.
 */
export function startAntigravityLogin(
  userId: string,
  profileId: string,
  profileDir: string,
): Promise<{ authUrl: string }> {
  // Cancel any existing session for this user
  cancelAntigravityLogin(userId);

  const override = envValue("ANTIGRAVITY_BIN_PATH");
  const resolved = resolveAntigravityBinary();
  if (override && !resolved) {
    return Promise.reject(new AntigravityLoginError("start_failed"));
  }
  const binary = resolved ?? "agy";
  let child: ChildProcess;
  try {
    child = spawn(binary, ["acp", "--login", "--gemini-dir", profileDir], {
      cwd: profileDir,
      env: antigravityChildEnv(profileDir),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return Promise.reject(new AntigravityLoginError("start_failed"));
  }

  return new Promise<{ authUrl: string }>((resolve, reject) => {
    let settled = false;
    let output = "";

    const forget = () => {
      const current = activeSessions.get(userId);
      if (current && current.child === child) takeSession(userId);
    };

    const fail = (failure: AntigravityLoginFailure) => {
      if (settled) return;
      settled = true;
      reject(new AntigravityLoginError(failure));
    };

    const timeoutId = setTimeout(() => {
      cancelAntigravityLogin(userId);
    }, AUTH_SESSION_TIMEOUT_MS);
    activeSessions.set(userId, { child, timeoutId });

    const onOutput = (chunk: Buffer | string) => {
      if (settled) return;
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
      const match = output.match(GOOGLE_AUTH_URL_REGEX);
      if (match) {
        settled = true;
        resolve({ authUrl: match[1] });
      }
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);

    child.on("error", () => {
      fail("start_failed");
      forget();
    });

    child.on("exit", (code) => {
      if (!settled) {
        // The exit code is the only detail logged. The output stays out of the log.
        console.warn(
          `Antigravity login exited before it showed a sign-in link (exit ${code ?? "by signal"})`,
        );
        fail("start_failed");
      }
      forget();
    });
  });
}

/**
 * Submit the authorization code (or redirect URL) entered by the user into
 * the stdin of the running `agy acp --login` process.
 *
 * Resolves with `null` on success, or with the failure reason. The session is
 * removed on the first submit, so a second submit of the same session gets
 * `session_expired` and does not write to the process again.
 */
export function submitAntigravityAuthCode(
  userId: string,
  code: string,
): Promise<AntigravityLoginFailure | null> {
  const cleanCode = code.trim();
  if (!cleanCode) return Promise.resolve("empty_code");

  const session = takeSession(userId);
  if (!session) return Promise.resolve("session_expired");

  const child = session.child;
  return new Promise<AntigravityLoginFailure | null>((resolve) => {
    let done = false;
    const finish = (failure: AntigravityLoginFailure | null) => {
      if (done) return;
      done = true;
      clearTimeout(exchangeTimer);
      resolve(failure);
    };

    const exchangeTimer = setTimeout(() => {
      finish("login_timed_out");
      stopChild(child);
    }, CODE_EXCHANGE_TIMEOUT_MS);

    child.once("exit", (exitCode) => {
      finish(exitCode === 0 ? null : "login_failed");
    });
    child.stdin?.on("error", () => {
      finish("login_failed");
      stopChild(child);
    });

    try {
      child.stdin?.write(cleanCode + "\n");
    } catch {
      finish("login_failed");
      stopChild(child);
    }
  });
}
