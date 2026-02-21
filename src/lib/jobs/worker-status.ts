/**
 * In-memory worker status tracking.
 * Updated by the reminder worker, read by the admin status API.
 *
 * Uses globalThis to share state across Turbopack chunks.
 * Without this, the instrumentation chunk and API route chunk
 * each get their own copy of module-level variables.
 */

interface WorkerStatus {
  running: boolean;
  startedAt: string | null;
  lastHeartbeat: string | null;
  lastReminderCheck: string | null;
  lastWithingsSync: string | null;
  lastInsightsRun: string | null;
  jobsProcessed: number;
  errors: number;
}

const GLOBAL_KEY = "__healthlog_worker_status__" as const;

function getStatus(): WorkerStatus {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      running: false,
      startedAt: null,
      lastHeartbeat: null,
      lastReminderCheck: null,
      lastWithingsSync: null,
      lastInsightsRun: null,
      jobsProcessed: 0,
      errors: 0,
    };
  }
  return g[GLOBAL_KEY] as WorkerStatus;
}

export function markWorkerStarted() {
  const status = getStatus();
  status.running = true;
  status.startedAt = new Date().toISOString();
  status.lastHeartbeat = new Date().toISOString();
}

export function recordHeartbeat() {
  const status = getStatus();
  status.lastHeartbeat = new Date().toISOString();
}

export function recordReminderCheck() {
  const status = getStatus();
  status.lastReminderCheck = new Date().toISOString();
  status.lastHeartbeat = new Date().toISOString();
  status.jobsProcessed++;
}

export function recordWithingsSync() {
  const status = getStatus();
  status.lastWithingsSync = new Date().toISOString();
  status.lastHeartbeat = new Date().toISOString();
  status.jobsProcessed++;
}

export function recordInsightsRun() {
  const status = getStatus();
  status.lastInsightsRun = new Date().toISOString();
  status.lastHeartbeat = new Date().toISOString();
  status.jobsProcessed++;
}

export function recordError() {
  const status = getStatus();
  status.errors++;
}

export function getWorkerStatus(): Readonly<WorkerStatus> {
  return { ...getStatus() };
}
