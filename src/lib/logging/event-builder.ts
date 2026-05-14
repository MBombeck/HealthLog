import { randomUUID } from "node:crypto";
import type { WideEvent, LogLevel, EventKind } from "./types";
import { LOG_LEVEL_PRIORITY } from "./types";
import { getDeployContext } from "./config";
import { redactOptional, redactSecrets } from "./redact";

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

  setAction(action: WideEvent["action"]): this {
    this.event.action = action;
    return this;
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
    this.event.warnings.push(msg);
    return this;
  }

  addExternalCall(call: NonNullable<WideEvent["external_calls"]>[0]): this {
    if (!this.event.external_calls) this.event.external_calls = [];
    this.event.external_calls.push(call);
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
    this.event.meta[key] = value;
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

  getRequestId(): string {
    return this.event.request_id!;
  }

  getTraceId(): string {
    return this.event.trace_id!;
  }
}
