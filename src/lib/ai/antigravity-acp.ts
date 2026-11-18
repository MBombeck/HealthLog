/**
 * The ACP connection to one `agy acp` child process: spawn, JSON-RPC over
 * stdio, the permission gate and a bounded close.
 *
 * The connection never logs what it reads. stderr can carry the prompt, the
 * paths or the account, so it is drained and dropped.
 *
 * @see antigravity-client.ts for the calls the provider makes on top of it.
 */
import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";

import { ANTIGRAVITY_ERRORS, AntigravityError } from "./antigravity-errors";
import { resolveAntigravityBinary } from "./antigravity-install";

/** How long a closing child gets after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** Upper bound on one unparsed line. A runaway agent cannot grow memory without limit. */
const MAX_BUFFER_CHARS = 16 * 1024 * 1024;

interface JsonRpcError {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string };
}

interface AcpPermissionOption {
  optionId: string;
  kind: string;
}

// ─── One child process and its JSON-RPC connection ───────────

interface PendingCall {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: AntigravityError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AcpConnection {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingCall>();

  /**
   * Number of times the agent has asked for a permission we refused. After
   * MAX_PERMISSION_REFUSALS the session is killed so we don't block for the
   * full prompt timeout while agy retries the same rejected step.
   */
  private permissionRefusals = 0;
  private static readonly MAX_PERMISSION_REFUSALS = 3;

  /**
   * Set as soon as we know no new outgoing calls should be accepted: a stdin
   * write error, an explicit close(), or a fatal process error. Setting this
   * does NOT immediately reject in-flight pending calls — stdout may still
   * deliver their responses via the 'data' → onLine() path.
   */
  private closedError: AntigravityError | null = null;

  private readonly exited: Promise<void>;

  /** Receives each `session/update` notification from the agent. */
  onSessionUpdate: (update: AcpSessionUpdate) => void = () => {};

  private constructor(private readonly child: ChildProcess) {
    this.exited = new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });

    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    // stderr can carry user data or secrets. Drain it and never log it.
    child.stderr?.resume();

    // A stdin write error (EPIPE) means agy has already closed its write end
    // of the pipe — typically because it finished and exited naturally. The
    // response for any in-flight session/prompt is already in the stdout pipe
    // buffer and will arrive via 'data' events. Record the error so call()
    // rejects new requests, but do NOT reject pending calls here: stdout
    // 'close' will do that after all buffered data has been delivered.
    child.stdin?.on("error", () => {
      this.closedError ??= new AntigravityError(
        "agy stdin closed",
        ANTIGRAVITY_ERRORS.PROCESS_ERROR,
      );
    });

    // A spawn-level or OS-level error means the process never ran or its I/O
    // is broken beyond recovery. Stdout will not produce valid data, so reject
    // pending calls immediately.
    child.on("error", (err) =>
      this.failAll(
        new AntigravityError(
          "agy process error",
          ANTIGRAVITY_ERRORS.PROCESS_ERROR,
          err,
        ),
      ),
    );

    // stdout 'close' fires only after every last byte has been delivered to
    // 'data' handlers and processed by onLine(). Any pending call that
    // survives to this point will never receive a response from a natural exit
    // — reject them now.
    child.stdout?.on("close", () =>
      this.failAll(
        this.closedError ??
          new AntigravityError(
            "agy stdout closed",
            ANTIGRAVITY_ERRORS.PROCESS_ERROR,
          ),
      ),
    );
  }

  /** Spawn `agy` and resolve once the process has started. */
  static start(
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ): Promise<AcpConnection> {
    return new Promise((resolve, reject) => {
      const binary = resolveAntigravityBinary() ?? "agy";
      let child: ChildProcess;
      try {
        child = spawn(binary, args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(
          new AntigravityError(
            "Failed to start agy",
            ANTIGRAVITY_ERRORS.CLI_UNAVAILABLE,
            err,
          ),
        );
        return;
      }
      let started = false;
      child.on("spawn", () => {
        started = true;
        resolve(new AcpConnection(child));
      });
      child.on("error", (err) => {
        if (!started) {
          reject(
            new AntigravityError(
              "Failed to start agy",
              ANTIGRAVITY_ERRORS.CLI_UNAVAILABLE,
              err,
            ),
          );
        }
      });
    });
  }

  /**
   * Send a request and wait for its response. Rejects on timeout or when the
   * connection fails. A JSON-RPC error in the response is returned, not thrown.
   */
  call(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<JsonRpcResponse> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AntigravityError(
            `${method} timed out after ${timeoutMs} ms`,
            ANTIGRAVITY_ERRORS.TIMEOUT,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * Stop the process: mark as closed (no new calls), send SIGTERM, wait for
   * the process to exit, then reject any pending calls that did not receive a
   * response. The stdout 'close' handler also rejects pending calls for the
   * natural-exit path; whichever fires first wins (failAll is idempotent once
   * the pending map is empty).
   */
  async close(): Promise<void> {
    this.closedError ??= new AntigravityError(
      "agy connection closed",
      ANTIGRAVITY_ERRORS.PROCESS_ERROR,
    );
    const child = this.child;
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    const killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    killTimer.unref();
    child.kill("SIGTERM");
    await this.exited;
    clearTimeout(killTimer);
    // Reject any pending calls that survived the kill. In a cancellation
    // scenario these will never receive a response; in the normal success path
    // the pending map is already empty by the time close() is called.
    this.failAll(this.closedError);
  }

  private write(message: object): void {
    this.child.stdin?.write(JSON.stringify(message) + "\n");
  }

  /**
   * Reject every pending call. Only called from the stdout 'close' handler
   * (after all data is read), from fatal process errors, and from close()
   * after the process exits. failAll is idempotent: once pending is empty it
   * is a no-op.
   */
  private failAll(error: AntigravityError): void {
    this.closedError ??= error;
    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      clearTimeout(call.timer);
      call.reject(error);
    }
  }

  private onData(chunk: Buffer): void {
    // StringDecoder keeps a multi-byte character that is split across chunks
    // intact (Polish letters are two bytes in UTF-8).
    this.buffer += this.decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      // The bound applies to one message. A chunk that holds many small
      // messages is fine.
      if (line.length > MAX_BUFFER_CHARS) {
        this.failOversized();
        return;
      }
      if (line) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
    // The part of a message still waiting for its newline is bounded too.
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.failOversized();
    }
  }

  private failOversized(): void {
    this.buffer = "";
    this.failAll(
      new AntigravityError(
        "agy sent an oversized message",
        ANTIGRAVITY_ERRORS.PROCESS_ERROR,
      ),
    );
  }

  private onLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // Not logged: the line may contain user data.
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (typeof msg.method === "string") {
      if (msg.id !== undefined) {
        // A request from the agent. It must be answered under the same id.
        this.onAgentRequest(msg.id, msg.method, msg.params);
      } else if (msg.method === "session/update") {
        const update = (msg.params as { update?: AcpSessionUpdate } | undefined)
          ?.update;
        if (update) this.onSessionUpdate(update);
      }
      return;
    }

    if (msg.id !== undefined) {
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      clearTimeout(call.timer);
      call.resolve({ id: msg.id, result: msg.result, error: msg.error });
    }
  }

  private onAgentRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): void {
    if (method === "session/request_permission") {
      // HealthLog grants no permissions. Prefer a permanent-reject option
      // (reject_all / never_allow) when the agent offers one, then fall back
      // to reject_once. If neither is available, answer "cancelled" — but
      // count every refusal so we can bail out before agy loops for the full
      // prompt timeout retrying the same refused step.
      const options =
        (params as { options?: AcpPermissionOption[] } | undefined)?.options ??
        [];
      const permanentReject = options.find(
        (o) => o.kind === "reject_all" || o.kind === "never_allow",
      );
      const rejectOnce = options.find((o) => o.kind === "reject_once");
      const chosen = permanentReject ?? rejectOnce;
      const outcome = chosen
        ? { outcome: "selected", optionId: chosen.optionId }
        : { outcome: "cancelled" };
      this.write({ jsonrpc: "2.0", id, result: { outcome } });

      this.permissionRefusals += 1;
      if (this.permissionRefusals >= AcpConnection.MAX_PERMISSION_REFUSALS) {
        this.failAll(
          new AntigravityError(
            "agy exceeded permission refusal limit",
            ANTIGRAVITY_ERRORS.PROMPT_FAILED,
          ),
        );
      }
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not supported: ${method}` },
    });
  }
}
