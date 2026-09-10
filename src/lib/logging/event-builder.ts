import { randomUUID } from "node:crypto";
import type { WideEvent, LogLevel, EventKind } from "./types";
import type { ProviderWorkAuthority } from "@/lib/sharing/provider-work-authority";
import { LOG_LEVEL_PRIORITY } from "./types";
import { getDeployContext } from "./config";
import { redactOptional, redactSecrets } from "./redact";

/**
 * Apply `redactSecrets` to every string a value contains, at any depth.
 *
 * The builder's contract is that nothing leaves through it unscrubbed. Strings
 * nested inside an object or array are just as visible in the emitted JSON as a
 * top-level one, so the walk has to reach them. Non-strings pass through
 * untouched; the structure is rebuilt rather than mutated so a caller's object
 * is never modified behind its back.
 *
 * The depth bound stops a cyclic or pathologically nested value from turning a
 * log write into a stack overflow. Anything past it is dropped rather than
 * emitted unscrubbed — an unreadable log line is recoverable, a leaked
 * credential is not.
 */
function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 8) return "[redacted: too deep]" as unknown as T;
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Baut ein Wide Event Schritt fuer Schritt auf.
 * Wird am Anfang eines Requests/Tasks erstellt und am Ende emittiert.
 */
export class WideEventBuilder {
  private event: Partial<WideEvent>;
  private startTime: number;
  private highestLevel: LogLevel = "info";

  constructor(kind: EventKind = "http") {
    this.startTime = performance.now();
    this.event = {
      timestamp: new Date().toISOString(),
      request_id: randomUUID(),
      trace_id: randomUUID(),
      kind,
      service: "healthlog",
      environment: process.env.NODE_ENV || "development",
      deploy: getDeployContext(),
      level: "info",
    };
  }

  setRequestId(id: string): this {
    this.event.request_id = id;
    return this;
  }

  setTraceId(id: string): this {
    this.event.trace_id = id;
    return this;
  }

  setHttp(http: WideEvent["http"]): this {
    if (http) {
      // Fix-J (v1.4.25 W21): the Withings webhook ships its shared
      // secret as a path segment, so `path` and `route` carry the
      // secret unless we scrub on the way in. `redactSecrets` is the
      // single egress-redaction surface (see redact.ts for the rules
      // and the PATH_SECRET_PATHS registry).
      this.event.http = {
        ...http,
        path: redactSecrets(http.path),
        route: redactSecrets(http.route),
      };
    } else {
      this.event.http = http;
    }
    return this;
  }

  setAuth(auth: WideEvent["auth"]): this {
    this.event.auth = auth;
    return this;
  }

  /**
   * v1.36.0 — record that this request acted on another account's record.
   *
   * Merges rather than replaces, because the actor identity is already on the
   * event by the time the acting account is resolved and overwriting it is the
   * exact confusion the two fields exist to prevent.
   */
  setActingAs(userId: string): this {
    this.event.auth = { ...(this.event.auth ?? {}), acting_as: userId };
    return this;
  }

  /**
   * v1.37.0 — record that provider generation is closed on this request.
   *
   * Merges for the same reason `setActingAs` does, and is stamped in the same
   * place: the record resolver, which is where the owner row is in hand. It is
   * read back through `delegatedGenerationSuppressed()`.
   */
  setDelegatedGenerationSuppressed(): this {
    this.event.auth = {
      ...(this.event.auth ?? {}),
      delegated_generation: "suppressed",
    };
    return this;
  }

  /**
   * v1.37.0 — record the record context this request resolved.
   *
   * Merges for the same reason `setActingAs` does. Written by exactly one
   * caller, the record-session fence, and read back by `apiHandler` to attach
   * the response echo. `apiHandler` deliberately does NOT derive the context
   * itself: doing so would put a session read on every public route and make
   * the echo a second derivation rather than a report of the one that was used.
   */
  setRecordContext(context: { epoch: number; scope: string | null }): this {
    this.event.auth = { ...(this.event.auth ?? {}), record_context: context };
    return this;
  }

  /** The record context the fence stamped, or undefined if it never ran. */
  getRecordContext(): { epoch: number; scope: string | null } | undefined {
    return this.event.auth?.record_context;
  }

  setProviderWorkAuthority(authority: ProviderWorkAuthority): this {
    this.event.auth = {
      ...(this.event.auth ?? {}),
      provider_work_authority: authority,
    };
    return this;
  }

  setAction(action: WideEvent["action"]): this {
    this.event.action = action;
    return this;
  }

  /**
   * Whether a caller has already named this event's action. A leaf that
   * wants to mark the event (the private-origin egress mark in the
   * notification senders) checks this first so it never overwrites the
   * route's or job's own action name, which dashboards pin on.
   */
  hasAction(): boolean {
    return this.event.action !== undefined;
  }

  setBackground(bg: WideEvent["background"]): this {
    this.event.background = bg;
    return this;
  }

  setError(err: unknown): this {
    this.elevateLevel("error");
    if (err instanceof Error) {
      this.event.error = {
        type: err.constructor.name,
        message: redactSecrets(err.message),
        stack: redactOptional(err.stack),
        code: (err as { statusCode?: number }).statusCode,
      };
    } else {
      this.event.error = {
        type: "Unknown",
        message: redactSecrets(String(err)),
      };
    }
    return this;
  }

  addWarning(msg: string): this {
    this.elevateLevel("warn");
    if (!this.event.warnings) this.event.warnings = [];
    // Scrub on the way in, like setError / setHttp / addExternalCall. A warning
    // often carries an outbound error string, which for several integrations is
    // the request URL with a credential in it (a bot token, an OAuth code, a
    // licence key). The redaction contract is the builder's, not each caller's.
    this.event.warnings.push(redactSecrets(msg));
    return this;
  }

  addExternalCall(call: NonNullable<WideEvent["external_calls"]>[0]): this {
    if (!this.event.external_calls) this.event.external_calls = [];
    // An outbound failure carries whatever the remote said, and for several
    // integrations that is the request URL — which for Telegram embeds the bot
    // token. `setError` and `setHttp` scrub on the way in; this entry point did
    // not, so a credential that is encrypted at rest reached stdout and the log
    // store in plaintext. Scrub here too: the redaction contract is the
    // builder's, not each caller's.
    this.event.external_calls.push(redactDeep(call));
    return this;
  }

  addDbQuery(durationMs: number): this {
    if (!this.event.db)
      this.event.db = { query_count: 0, query_duration_ms: 0 };
    this.event.db.query_count++;
    this.event.db.query_duration_ms += durationMs;
    return this;
  }

  setRateLimit(info: WideEvent["rate_limit"]): this {
    this.event.rate_limit = info;
    return this;
  }

  addMeta(key: string, value: unknown): this {
    if (!this.event.meta) this.event.meta = {};
    // Meta is emitted verbatim: the finished event is JSON-stringified whole to
    // stdout and the log store. It was the one builder entry point that did not
    // scrub, which made it a trusted sink by accident rather than by design —
    // and the AI provider chain feeds upstream error bodies through it, so a
    // gateway that echoes the offending request put prompt content and
    // non-standard credentials into the logs. Scrub every string, at any depth.
    this.event.meta[key] = redactDeep(value);
    return this;
  }

  /** Level nur hochstufen, nie runter */
  elevateLevel(level: LogLevel): this {
    if (LOG_LEVEL_PRIORITY[level] > LOG_LEVEL_PRIORITY[this.highestLevel]) {
      this.highestLevel = level;
    }
    return this;
  }

  /** Request/Operation beenden, Duration berechnen */
  finish(httpStatus?: number): this {
    this.event.duration_ms = Math.round(performance.now() - this.startTime);
    // Event-Loop-Lag des letzten Sampling-Fensters anheften, falls der
    // Monitor laeuft. Bewusst ueber den Global-Slot statt Import gelesen:
    // dieser Builder wird in die Edge-Runtime gebuendelt, wo perf_hooks
    // nicht existiert — der Slot ist dort einfach leer.
    const lag = (
      globalThis as unknown as {
        [key: symbol]: { loop_max_ms: number; loop_last_ms: number };
      }
    )[Symbol.for("healthlog.eventLoopLag")];
    if (lag) this.event.runtime = lag;
    if (httpStatus !== undefined && this.event.http) {
      this.event.http.status = httpStatus;
    }
    if (httpStatus !== undefined) {
      if (httpStatus >= 500) this.elevateLevel("error");
      else if (httpStatus >= 400) this.elevateLevel("warn");
    }
    this.event.level = this.highestLevel;
    return this;
  }

  toJSON(): WideEvent {
    return structuredClone(this.event) as WideEvent;
  }

  getDurationMs(): number {
    return Math.round(performance.now() - this.startTime);
  }

  getLevel(): LogLevel {
    return this.highestLevel;
  }

  /** The HTTP method of the current request, if one was attached. */
  getHttpMethod(): string | undefined {
    return this.event.http?.method;
  }

  /**
   * Who authenticated, and whose record they are acting on.
   *
   * v1.36.0 — read by `auditLog()`, which needs both halves and must not be
   * handed either one by a call site. The event is already the one place that
   * knows them: `setAuth` stamps the actor at authentication, `setActingAs`
   * stamps the owner when the resolver substitutes one, and both run before any
   * handler body can write an audit row. A copy of this fact threaded through
   * function arguments would be a second answer to "who is doing this", and the
   * routes that forgot to pass it would be the ones nobody reviewed.
   */
  getAuth(): WideEvent["auth"] {
    return this.event.auth;
  }

  getRequestId(): string {
    return this.event.request_id!;
  }

  getTraceId(): string {
    return this.event.trace_id!;
  }
}
