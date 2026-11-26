/**
 * v1.4.22 — shared `ReadableStream` constructor
 * for Server-Sent-Events handlers.
 *
 * The Coach chat route used to construct three separate
 * `new ReadableStream({ start(controller) { try { … } finally {
 * controller.close(); } } })` blocks — one for the refusal path, one
 * for the provider-error path, one for the happy path. Each emitted a
 * different mix of frames but the construction shape was identical.
 *
 * Extract the boilerplate so future SSE consumers (the v1.5 iOS
 * daily-briefing live-regenerate endpoint is the next one) inherit the
 * same try/finally close semantics without copy-paste.
 *
 * The `emit` callback receives the controller and is awaited inside
 * the `start` body. Any error inside the callback re-enters the
 * `finally` and closes the stream cleanly so the client sees the
 * connection terminate (and never sees a hung response).
 */

export interface SseController<T = Uint8Array> {
  enqueue: (chunk: T) => void;
  /**
   * v1.18.10 — aborts when the consumer cancels the stream (client
   * disconnect, navigation away, `Response.body.cancel()`). The `emit`
   * callback should check `signal.aborted` between frames and stop producing,
   * and pass `signal` to any in-flight provider fetch so a mid-stream
   * disconnect tears the upstream call down instead of streaming into the void.
   */
  signal: AbortSignal;
}

/**
 * Build a `ReadableStream<Uint8Array>` whose `start` callback runs the
 * supplied `emit` function inside a try/finally that always closes the
 * controller. Use the returned stream with the standard SSE response
 * headers (`Content-Type: text/event-stream`, `Cache-Control: private, no-store, no-transform`).
 *
 * v1.18.10 — the stream now wires a `cancel` handler: when the consumer
 * cancels (client disconnect), the shared `AbortController` fires, so the
 * `emit` callback's `signal` flips to aborted and any provider fetch wired to
 * it is torn down. Without this the emit loop kept enqueuing frames (and an
 * abort-less upstream fetch kept running) after the client had gone.
 */
export function createSseStream(
  emit: (controller: SseController) => void | Promise<void>,
): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const sse: SseController = {
        enqueue: (chunk) => {
          // A late enqueue after the consumer cancelled would throw on the
          // closed controller — swallow it so the abort path stays clean.
          if (abort.signal.aborted) return;
          controller.enqueue(chunk);
        },
        signal: abort.signal,
      };
      try {
        await emit(sse);
      } finally {
        controller.close();
      }
    },
    cancel(reason) {
      abort.abort(reason);
    },
  });
}
