import type { ProviderWorkAuthority } from "@/lib/sharing/provider-work-authority";

/** Log-Levels in aufsteigender Schwere */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Numerische Prioritaet fuer Level-Vergleiche */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Typ der Operation: HTTP-Request oder Hintergrundaufgabe */
export type EventKind = "http" | "background";

/**
 * Das zentrale Wide-Event-Schema.
 * Ein einzelnes JSON-Objekt pro Request/Operation mit allen relevanten Dimensionen.
 */
export interface WideEvent {
  // Kern-Metadaten
  timestamp: string;
  duration_ms: number;
  request_id: string;
  trace_id: string;
  level: LogLevel;
  kind: EventKind;
  service: string;
  environment: string;

  // Deployment/Runtime-Kontext (einmal beim Start erfasst)
  deploy?: {
    commit_hash?: string;
    version?: string;
    node_version?: string;
    hostname?: string;
  };

  // HTTP-Request-Daten (nur bei kind === "http")
  http?: {
    method: string;
    path: string;
    route: string;
    status: number;
    user_agent?: string;
    ip?: string;
    content_length?: number;
    response_size?: number;
  };

  // Authentifizierung / Benutzer
  auth?: {
    user_id?: string;
    user_role?: string;
    auth_method?:
      | "session"
      | "bearer"
      | "api_key"
      | "cron_secret"
      | "telegram_webhook"
      | "webhook_secret";
    /**
     * v1.36.0 — the account whose record this request read or wrote, when it
     * is not the caller's own. `user_id` above always stays the ACTOR: the
     * person who authenticated. Two fields rather than one swapped field,
     * because "who did it" and "whose record" are different questions and a
     * dashboard that conflates them cannot answer either.
     */
    acting_as?: string;
    /**
     * v1.37.0 — set when this request is acting on somebody else's record and
     * that somebody could have asked for the generation themselves. It is the
     * one fact the generated reads consult before enqueuing a provider job:
     * a manager's navigation must not spend the owner's budget or ship the
     * owner's record to the owner's provider. Absent means "generate as
     * usual", which is what every self-request, every guardian request on a
     * managed profile and every background job is.
     */
    delegated_generation?: "suppressed";
    /** Durable authority copied into provider queue payloads. */
    provider_work_authority?: ProviderWorkAuthority;
    /**
     * v1.37.0 — the record context this request was actually served under, as
     * the record-session fence read it off the session row.
     *
     * Stamped by the fence on every call it makes, pass or refuse, and by
     * nothing else. `apiHandler` copies it onto two response headers so the
     * browser can discard a response that resolved a different record than the
     * one it is now showing. Present exactly on the responses that resolved a
     * record scope; absent everywhere else, which is what makes "no echo" mean
     * "nothing about a record was decided here" rather than "unknown".
     */
    record_context?: { epoch: number; scope: string | null };
  };

  // Business-Daten (was wurde getan)
  action?: {
    name: string;
    entity_id?: string;
    entity_type?: string;
    details?: Record<string, unknown>;
  };

  // Datenbank-Metriken
  db?: {
    query_count: number;
    query_duration_ms: number;
  };

  // Externe Aufrufe (Telegram, Webhooks, etc.)
  external_calls?: Array<{
    service: string;
    method: string;
    duration_ms: number;
    status?: number;
    error?: string;
    /**
     * v1.42 — an expected non-2xx the caller recovers from by design (a
     * filter dialect probe), recorded without `error` so a query for
     * failed calls does not find it.
     */
    note?: string;
  }>;

  // Hintergrundaufgabe (nur bei kind === "background")
  background?: {
    task_name: string;
    result?: Record<string, unknown>;
  };

  // Prozess-Zustand zum Abschlusszeitpunkt (nur Node-Runtime; siehe
  // observability/event-loop-lag.ts — das letzte Sampling-Fenster der
  // Event-Loop-Verzoegerung, damit der erste Request nach einem Stall
  // den Stall mitfuehrt)
  runtime?: {
    loop_max_ms: number;
    loop_last_ms: number;
  };

  // Fehler-Details
  error?: {
    type: string;
    code?: string | number;
    message: string;
    stack?: string;
  };

  // Warnungen (gesammelt waehrend der Ausfuehrung)
  warnings?: string[];

  // Rate-Limiting
  rate_limit?: {
    key: string;
    allowed: boolean;
    remaining: number;
  };

  // Freie Zusatzfelder
  meta?: Record<string, unknown>;
}

/** Konfiguration fuer das Logging-System */
export interface LoggingConfig {
  level: LogLevel;
  lokiEndpoint?: string;
  lokiUsername?: string;
  lokiPassword?: string;
  sampleRate: number;
  slowThresholdMs: number;
  includeStackTrace: boolean;
  prettyPrint: boolean;
}
