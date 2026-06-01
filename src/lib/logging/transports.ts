import type { WideEvent } from "./types";
import { getLoggingConfig } from "./config";
import { shouldEmit } from "./sampler";
import { appendLogEvent } from "./in-memory-buffer";
import { safeFetch } from "@/lib/safe-fetch";

/** Event auf stdout als einzelne JSON-Zeile schreiben */
function emitToStdout(event: WideEvent): void {
  const config = getLoggingConfig();
  const json = config.prettyPrint
    ? JSON.stringify(event, null, 2)
    : JSON.stringify(event);
  process.stdout.write(json + "\n");
}

// Loki Push API Buffer
const LOKI_MAX_BUFFER_SIZE = 1000;
let lokiBuffer: WideEvent[] = [];
let lokiFlushTimer: ReturnType<typeof setInterval> | null = null;

function initLokiTransport(): void {
  const config = getLoggingConfig();
  if (!config.lokiEndpoint || lokiFlushTimer) return;

  lokiFlushTimer = setInterval(() => {
    flushLokiBuffer().catch((err) => {
      process.stderr.write(`[logging] Loki flush error: ${err}\n`);
    });
  }, 5000);

  if (lokiFlushTimer.unref) lokiFlushTimer.unref();
}

async function flushLokiBuffer(): Promise<void> {
  if (lokiBuffer.length === 0) return;
  const config = getLoggingConfig();
  if (!config.lokiEndpoint) return;

  const batch = lokiBuffer;
  lokiBuffer = [];

  const streams = [
    {
      stream: {
        service: "healthlog",
        environment: batch[0]?.environment || "production",
      },
      values: batch.map((event) => [
        // Loki erwartet Nanosekunden-Timestamp als String
        new Date(event.timestamp).getTime() + "000000",
        JSON.stringify(event),
      ]),
    },
  ];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.lokiUsername && config.lokiPassword) {
    headers["Authorization"] =
      "Basic " +
      Buffer.from(`${config.lokiUsername}:${config.lokiPassword}`).toString(
        "base64",
      );
  }

  try {
    await safeFetch(
      `${config.lokiEndpoint}/loki/api/v1/push`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ streams }),
      },
      // Operator-configured Loki endpoint — pin the connect-time IP
      // against DNS rebinding.
      { timeoutMs: 10_000, requirePublicHost: true },
    );
  } catch {
    // Events gehen verloren — akzeptabel fuer Logging
  }
}

/**
 * Event emittieren falls Sampling-Kriterien erfuellt.
 * Zentraler Einstiegspunkt — entfernt Stack Traces falls konfiguriert.
 */
export function emitIfSampled(event: WideEvent): void {
  const config = getLoggingConfig();
  if (!config.includeStackTrace && event.error?.stack) {
    delete event.error.stack;
  }
  if (shouldEmit(event)) {
    emitEvent(event);
  }
}

/** Zentraler Emit: stdout + optional Loki-Buffer + in-memory ring buffer */
export function emitEvent(event: WideEvent): void {
  emitToStdout(event);

  // Push into the per-process in-memory ring buffer so admins can drill
  // into the most recent ~500 wide events from the `/admin/app-logs`
  // page without standing up a Loki stack. See `in-memory-buffer.ts`.
  // Wrapped in try/catch so a buffer bug never poisons the request.
  try {
    appendLogEvent(event);
  } catch {
    /* logging must never crash the handler */
  }

  const config = getLoggingConfig();
  if (config.lokiEndpoint) {
    initLokiTransport();
    if (lokiBuffer.length >= LOKI_MAX_BUFFER_SIZE) {
      lokiBuffer.shift();
    }
    lokiBuffer.push(event);
  }
}
