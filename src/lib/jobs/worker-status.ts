/**
 * In-memory worker status tracking.
 * Updated by the reminder worker, read by the admin status API.
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

const status: WorkerStatus = {
  running: false,
  startedAt: null,
  lastHeartbeat: null,
  lastReminderCheck: null,
  lastWithingsSync: null,
  lastInsightsRun: null,
  jobsProcessed: 0,
  errors: 0,
};

export function markWorkerStarted() {
  status.running = true;
  status.startedAt = new Date().toISOString();
  status.lastHeartbeat = new Date().toISOString();
}

export function recordHeartbeat() {
  status.lastHeartbeat = new Date().toISOString();
}

export function recordReminderCheck() {
  status.lastReminderCheck = new Date().toISOString();
  status.lastHeartbeat = new Date().toISOString();
  status.jobsProcessed++;
}

export function recordWithingsSync() {
  status.lastWithingsSync = new Date().toISOString();
  status.lastHeartbeat = new Date().toISOString();
  status.jobsProcessed++;
}

export function recordInsightsRun() {
  status.lastInsightsRun = new Date().toISOString();
  status.lastHeartbeat = new Date().toISOString();
  status.jobsProcessed++;
}

export function recordError() {
  status.errors++;
}

export function getWorkerStatus(): Readonly<WorkerStatus> {
  return { ...status };
}
