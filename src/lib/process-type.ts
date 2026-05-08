/**
 * Process-type gate for the v1.4 web/worker split.
 *
 * The same Docker image runs both the Next.js HTTP server and the pg-boss
 * worker. Operators set `HEALTHLOG_PROCESS_TYPE` to declare what THIS
 * container is supposed to be:
 *
 *   - `all`    (default) — both web + worker in one container (legacy).
 *   - `web`    — HTTP only; the worker MUST run elsewhere.
 *   - `worker` — pg-boss only; the HTTP server MUST run elsewhere.
 *
 * A safety gate refuses to start the wrong subsystem so split deployments
 * don't accidentally double-run reminder workers (which would still be
 * safe due to pg-boss claim semantics, but doubles DB load and confuses
 * telemetry).
 */

export type ProcessType = "web" | "worker" | "all";

export function getProcessType(): ProcessType {
  const raw = process.env.HEALTHLOG_PROCESS_TYPE;
  // Treat empty string and unset alike — the docker-compose default
  // interpolation gives an empty string when the var isn't set.
  if (!raw || raw.trim() === "") return "all";
  const normalized = raw.toLowerCase();
  if (normalized === "web" || normalized === "worker" || normalized === "all") {
    return normalized;
  }
  throw new Error(
    `Invalid HEALTHLOG_PROCESS_TYPE='${raw}'. Expected: web | worker | all.`,
  );
}

export function shouldRunWeb(): boolean {
  const t = getProcessType();
  return t === "web" || t === "all";
}

export function shouldRunWorker(): boolean {
  const t = getProcessType();
  return t === "worker" || t === "all";
}

/**
 * Throw when the calling subsystem is disabled by HEALTHLOG_PROCESS_TYPE.
 * Used at the top of the worker entry-point so an accidental
 * `HEALTHLOG_PROCESS_TYPE=web node reminder-worker.js` exits immediately
 * instead of silently running queues twice.
 */
export function assertSubsystemEnabled(subsystem: "web" | "worker"): void {
  if (subsystem === "web" && !shouldRunWeb()) {
    throw new Error(
      `Refusing to start web subsystem: HEALTHLOG_PROCESS_TYPE=${getProcessType()}`,
    );
  }
  if (subsystem === "worker" && !shouldRunWorker()) {
    throw new Error(
      `Refusing to start worker subsystem: HEALTHLOG_PROCESS_TYPE=${getProcessType()}`,
    );
  }
}
