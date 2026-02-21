import type { Instrumentation } from "next";

export async function register() {
  // Only start the worker on the Node.js server runtime (not Edge, not build)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    console.log("[instrumentation] Node.js runtime detected, starting reminder worker...");
    console.log("[instrumentation] NODE_PATH:", process.env.NODE_PATH ?? "(not set)");
    try {
      const { startReminderWorker } = await import("@/lib/jobs/reminder-worker");
      console.log("[instrumentation] reminder-worker module loaded successfully");
      await startReminderWorker();
      console.log("[instrumentation] Reminder worker started successfully");
    } catch (err) {
      console.error("[instrumentation] CRITICAL: Failed to start reminder worker:", err);
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
    const [{ getGlitchtipSettings }, { sendGlitchtipEvent }] = await Promise.all([
      import("@/lib/monitoring-settings"),
      import("@/lib/monitoring/glitchtip"),
    ]);

    const settings = await getGlitchtipSettings();
    if (!settings.glitchtipEnabled || !settings.glitchtipDsn) return;

    const err =
      error instanceof Error
        ? error
        : new Error(typeof error === "string" ? error : "Unhandled request error");

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
      context.revalidateReason ? `Revalidate: ${context.revalidateReason}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    const message = `${err.message} [${details}]`.slice(0, 1900);

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
    console.error("Global Glitchtip request error reporting crashed:", reportError);
  }
};
