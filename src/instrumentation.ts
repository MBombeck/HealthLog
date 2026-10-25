import type { Instrumentation } from "next";

/**
 * The admin notice for a host whose login-IP lookups leave it. The geo
 * resolver evaluates it on its first public-IP lookup; it holds a slot
 * rather than importing the notification layer (see the notice module).
 */
async function registerOfflineGeoNoticeAtBoot(): Promise<void> {
  try {
    const { registerOfflineGeoNotice } =
      await import("@/lib/notifications/offline-geo-notice");
    registerOfflineGeoNotice();
  } catch {
    // Without it the lookups still resolve; only the notice is missing.
  }
}

/**
 * Which connections may report a client address (TRUSTED_PROXY_CIDRS,
 * TRUST_PROXY_HOPS), said once, with a bad value named.
 */
async function logProxyTrustAtBootSafely(): Promise<void> {
  try {
    (await import("@/lib/http/proxy-trust")).logProxyTrustAtBoot();
  } catch {
    // A log line must never break boot.
  }
}

export async function register() {
  // Only start the worker on the Node.js server runtime (not Edge, not build)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // First: every request then carries its socket's address (peer-address).
    (await import("@/lib/http/peer-address")).installPeerAddressStamp();

    // The event-loop monitor comes first, so the loading of the database
    // client and of the worker graph is inside its view, and every stall it
    // reports names the boot step that was running (`boot-steps.ts`).
    const [{ startEventLoopLagMonitor }, { beginBootStep }] = await Promise.all(
      [
        import("@/lib/observability/event-loop-lag"),
        import("@/lib/boot/boot-steps"),
      ],
    );
    startEventLoopLagMonitor();

    // Every locale falls back to the English message catalog, so a process
    // without a readable `messages/en.json` cannot serve a page or a job.
    // Refuse to start with the file named, rather than fail every request.
    const { assertDefaultCatalogReadable } =
      await import("@/lib/i18n/server-catalogs");
    assertDefaultCatalogReadable();

    beginBootStep("readiness_summary");

    // First-boot readiness summary: a human-readable block on the core secrets
    // (with the exact fix on a bad one) before any fail-closed loader throws,
    // plus a one-glance status of the optional channels. Runs for every process
    // type (web + worker). Never throws — the real gate stays the loaders.
    try {
      const { logReadinessSummary } =
        await import("@/lib/boot/readiness-summary");
      logReadinessSummary();
    } catch {
      // A readiness summary must never break boot.
    }

    await registerOfflineGeoNoticeAtBoot();
    await logProxyTrustAtBootSafely();

    // Does the configured encryption key open this database? A process whose
    // key does not refuses every API request with one clear 503 and starts
    // neither the producer nor the worker (a wrong key must never write).
    beginBootStep("key_check");
    try {
      const [{ runBootKeyCheck }, { prisma }] = await Promise.all([
        import("@/lib/boot/key-check"),
        import("@/lib/db"),
      ]);
      if (await runBootKeyCheck(prisma)) return;
    } catch (err) {
      console.error("[instrumentation] Encryption key check crashed:", err);
    }

    // Every connection is pinned to UTC; say clearly if one is not.
    beginBootStep("time_zone_check");
    try {
      const [{ runBootTimeZoneCheck }, { prisma }] = await Promise.all([
        import("@/lib/boot/time-zone-check"),
        import("@/lib/db"),
      ]);
      await runBootTimeZoneCheck(prisma);
    } catch {
      // A diagnostic must never break boot.
    }

    // Every pulse reader follows the operator's pulse day-mean method; mirror
    // it in this process and keep the mirror current.
    beginBootStep("pulse_method_sync");
    try {
      const { startPulseDayMeanMethodSync } =
        await import("@/lib/measurements/pulse-day-mean-method");
      await startPulseDayMeanMethodSync();
    } catch {
      // Without the mirror the process keeps the default method.
    }

    // Every Node process watches its heap as it watches its event loop: a
    // trend line, and one report naming the work in flight before the heap
    // runs out (a heap-limit crash logs nothing else).
    beginBootStep("monitors");
    try {
      const [{ startHttpInFlightTracking }, { startHeapMonitor }] =
        await Promise.all([
          import("@/lib/observability/in-flight"),
          import("@/lib/observability/heap-monitor"),
        ]);
      startHttpInFlightTracking();
      startHeapMonitor();
    } catch {
      // A diagnostic must never break boot.
    }

    // One line when the container's memory limit is below the supported
    // floor. The app keeps running.
    try {
      const { logMemoryFloorAtBoot } = await import("@/lib/support/heap-limit");
      logMemoryFloorAtBoot();
    } catch {
      // A diagnostic must never break boot.
    }

    // The background role starts after the server is up. Awaiting it here
    // held every request, `/api/health` included, for the seconds pg-boss
    // needs to start, provision its queues and run the boot discovery; the
    // probe now answers `starting` meanwhile. A request that enqueues while
    // the boss is not bound yet takes the same path as during a producer
    // reconnect: the enqueue waits for the boss in the background
    // (`enqueueWhenBossReady`, bounded and logged when it gives up), and a
    // route that needs the worker answers 503 until it is up.
    const [
      { shouldRunWorker },
      { markStartup, startupPhase, startupElapsedMs, STARTING_MAX_MS },
    ] = await Promise.all([
      import("@/lib/process-type"),
      import("@/lib/boot/startup-state"),
    ]);
    markStartup("starting");
    // One line when the start takes longer than any real boot; from then on
    // the probe reports plain `degraded` instead of `starting`.
    setTimeout(() => {
      if (startupPhase() === "stalled") {
        console.warn(
          `[boot] The background role is still not up after ${Math.round(STARTING_MAX_MS / 1000)} s; /api/health now reports degraded without "starting".`,
        );
      }
    }, STARTING_MAX_MS + 1_000).unref();
    const ready = (up: boolean) => {
      const elapsed = startupElapsedMs();
      markStartup(up ? "ready" : "failed");
      console.info(
        `[boot] background role ${up ? "ready" : "failed"} after ${elapsed ?? 0} ms`,
      );
    };
    if (!shouldRunWorker()) {
      // Split deployment: web requests still produce queue jobs, but this
      // process owns no schedules, supervision, or consumers.
      void (async () => {
        try {
          beginBootStep("producer_start");
          const { startGlobalBossProducer } =
            await import("@/lib/jobs/boss-instance");
          const boss = await startGlobalBossProducer(process.env.DATABASE_URL);
          if (boss) {
            const { registerShutdownHandlers } =
              await import("@/lib/jobs/reminder/worker-lifecycle");
            registerShutdownHandlers(boss);
          }
          ready(boss !== null);
          const { reportBootSteps } = await import("@/lib/boot/boot-steps");
          await reportBootSteps();
        } catch (err) {
          ready(false);
          // Queue-backed garnishes degrade independently; never make the web
          // server unavailable because its producer connection failed.
          console.error(
            "[instrumentation] Failed to start pg-boss producer:",
            err,
          );
        }
      })();
      return;
    }

    void (async () => {
      const { WideEventBuilder } = await import("@/lib/logging/event-builder");
      const { emitIfSampled } = await import("@/lib/logging/transports");

      // Emit startup event
      const startupEvt = new WideEventBuilder("background");
      startupEvt.setBackground({ task_name: "startup" });

      try {
        beginBootStep("worker_import");
        const { startReminderWorker } =
          await import("@/lib/jobs/reminder-worker");
        await startReminderWorker();
        ready(true);

        startupEvt.addMeta("reminder_worker", "started");
        startupEvt.finish();
        emitIfSampled(startupEvt.toJSON());
      } catch (err) {
        ready(false);
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
    })();
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
