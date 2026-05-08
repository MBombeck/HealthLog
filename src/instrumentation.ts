import type { Instrumentation } from "next";

export async function register() {
  // Only start the worker on the Node.js server runtime (not Edge, not build)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { shouldRunWorker } = await import("@/lib/process-type");
    // Web-only container — the dedicated worker service runs the queues.
    if (!shouldRunWorker()) return;

    const { WideEventBuilder } = await import("@/lib/logging/event-builder");
    const { emitIfSampled } = await import("@/lib/logging/transports");

    // Emit startup event
    const startupEvt = new WideEventBuilder("background");
    startupEvt.setBackground({ task_name: "startup" });

    try {
      const { startReminderWorker } =
        await import("@/lib/jobs/reminder-worker");
      await startReminderWorker();

      startupEvt.addMeta("reminder_worker", "started");
      startupEvt.finish();
      emitIfSampled(startupEvt.toJSON());
    } catch (err) {
      startupEvt.setError(err);
      startupEvt.addMeta("reminder_worker", "failed");
      startupEvt.finish();
      emitIfSampled(startupEvt.toJSON());

      // Still log to stderr for container health checks
      console.error(
        "[instrumentation] CRITICAL: Failed to start reminder worker:",
        err,
      );
    }
  }
}

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  // Prisma-based settings lookup is not available in edge instrumentation.
  if (process.env.NEXT_RUNTIME === "edge") return;

  try {
    const [{ getGlitchtipSettings }, { sendGlitchtipEvent }] =
      await Promise.all([
        import("@/lib/monitoring-settings"),
        import("@/lib/monitoring/glitchtip"),
      ]);

    const settings = await getGlitchtipSettings();
    if (!settings.glitchtipEnabled || !settings.glitchtipDsn) return;

    const err =
      error instanceof Error
        ? error
        : new Error(
            typeof error === "string" ? error : "Unhandled request error",
          );

    // Skip expected errors from bot scanners (malformed JSON bodies)
    if (err instanceof SyntaxError) return;

    const userAgentHeader = request.headers["user-agent"];
    const userAgent = Array.isArray(userAgentHeader)
      ? userAgentHeader[0]
      : userAgentHeader;

    const details = [
      `Route: ${context.routePath}`,
      `Type: ${context.routeType}`,
      `Router: ${context.routerKind}`,
      `Method: ${request.method}`,
      `Path: ${request.path}`,
      context.renderSource ? `Render: ${context.renderSource}` : null,
      context.revalidateReason
        ? `Revalidate: ${context.revalidateReason}`
        : null,
    ]
      .filter(Boolean)
      .join(" | ");

    const message = `${err.message} [${details}]`.slice(0, 1900);

    // Try to get request_id from Wide Event context
    let requestId: string | undefined;
    try {
      const { getEvent } = await import("@/lib/logging/context");
      requestId = getEvent()?.getRequestId();
    } catch {
      // Logging not available in this context
    }

    const delivery = await sendGlitchtipEvent({
      dsn: settings.glitchtipDsn,
      input: {
        environment: settings.glitchtipEnvironment || "production",
        message,
        stack: err.stack,
        level: "error",
        type: err.name || "RequestError",
        url: request.path,
        userAgent,
        sourceTag: "healthlog-server",
        requestId,
      },
    });

    if (!delivery.ok) {
      console.error(
        "Global Glitchtip request error reporting failed:",
        delivery.status,
        delivery.details,
      );
    }
  } catch (reportError) {
    console.error(
      "Global Glitchtip request error reporting crashed:",
      reportError,
    );
  }
};
