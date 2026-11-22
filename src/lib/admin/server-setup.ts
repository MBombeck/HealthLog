/**
 * 1.49 — the first-admin server setup, as data.
 *
 * Five short steps an operator meets once, before or beside their own setup,
 * each skippable and each recorded: who may sign up and how, how
 * notifications leave the server, what AI may do, what else leaves the server,
 * and a read-only check of the setup's health. Every step is the existing
 * admin surface for that decision (the setup only puts them in an order), so
 * nothing here is a second writer of a setting.
 *
 * State lives on the singleton `AppSettings` row: `serverSetupCompletedAt`
 * and `serverSetupStepsJson`. Migration 0551 stamped every instance that
 * already had accounts, so an upgrade never offers the setup. It is never
 * offered on a demo deploy, and the setup screens refuse there.
 *
 * Pure and Prisma-free: the Zod schema, the OpenAPI generator and the screens
 * all read the same vocabulary.
 */

/** The steps, in the order the setup asks them. Additive like the person flow. */
export const SERVER_SETUP_STEP_IDS = [
  "accounts",
  "notifications",
  "ai",
  "privacy",
  "health",
] as const;

export type ServerSetupStepId = (typeof SERVER_SETUP_STEP_IDS)[number];

export const SERVER_SETUP_STEP_STATUSES = [
  "pending",
  "done",
  "skipped",
] as const;

export type ServerSetupStepStatus = (typeof SERVER_SETUP_STEP_STATUSES)[number];

export interface ServerSetupStepState {
  id: ServerSetupStepId;
  status: ServerSetupStepStatus;
}

/** The docs pages the steps link to (the public docs site). */
const DOCS = "https://docs.healthlog.dev";
export const SERVER_SETUP_DOCS = {
  signIn: `${DOCS}/guides/sign-in-and-security/`,
  invites: `${DOCS}/guides/invites/`,
  reminderChannels: `${DOCS}/guides/reminder-channels/`,
  pushRelay: `${DOCS}/guides/push-relay/`,
  aiProviders: `${DOCS}/guides/ai-providers/`,
  geolite2: `${DOCS}/self-hosting/geolite2/`,
  privacy: `${DOCS}/explanation/privacy-architecture/`,
  encryptionKeys: `${DOCS}/guides/encryption-key-rotation/`,
  reverseProxy: `${DOCS}/guides/reverse-proxy/`,
  backups: `${DOCS}/guides/backups/`,
  environment: `${DOCS}/reference/environment-variables/`,
  firstSteps: `${DOCS}/getting-started/first-steps/`,
} as const;

/** The admin notice id the setup's start-page notice is dismissed under. */
export const SERVER_SETUP_NOTICE_ID = "server_setup_available";

export function isServerSetupStepId(value: string): value is ServerSetupStepId {
  return (SERVER_SETUP_STEP_IDS as readonly string[]).includes(value);
}

/**
 * Read the stored steps as the full ordered list, fail-soft: an unknown id or
 * status is dropped, a missing step reads as pending.
 */
export function parseServerSetupSteps(value: unknown): ServerSetupStepState[] {
  const stored = new Map<string, ServerSetupStepStatus>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) continue;
      const { id, status } = entry as { id?: unknown; status?: unknown };
      if (
        typeof id === "string" &&
        isServerSetupStepId(id) &&
        typeof status === "string" &&
        (SERVER_SETUP_STEP_STATUSES as readonly string[]).includes(status)
      ) {
        stored.set(id, status as ServerSetupStepStatus);
      }
    }
  }
  return SERVER_SETUP_STEP_IDS.map((id) => ({
    id,
    status: stored.get(id) ?? "pending",
  }));
}

/** One step answered or passed; the others stay as they were. */
export function applyServerSetupStep(
  steps: readonly ServerSetupStepState[],
  id: ServerSetupStepId,
  status: Exclude<ServerSetupStepStatus, "pending">,
): ServerSetupStepState[] {
  return steps.map((step) => (step.id === id ? { ...step, status } : step));
}

export function everyServerSetupStepSettled(
  steps: readonly ServerSetupStepState[],
): boolean {
  return steps.every((step) => step.status !== "pending");
}

/** The first step still owed, or the first step when all are settled. */
export function serverSetupResumeStep(
  steps: readonly ServerSetupStepState[],
): ServerSetupStepId {
  return steps.find((step) => step.status === "pending")?.id ?? "accounts";
}

export function nextServerSetupStep(
  id: ServerSetupStepId,
): ServerSetupStepId | null {
  const index = SERVER_SETUP_STEP_IDS.indexOf(id);
  return SERVER_SETUP_STEP_IDS[index + 1] ?? null;
}

export function previousServerSetupStep(
  id: ServerSetupStepId,
): ServerSetupStepId | null {
  const index = SERVER_SETUP_STEP_IDS.indexOf(id);
  return index > 0 ? SERVER_SETUP_STEP_IDS[index - 1] : null;
}

/**
 * The environment facts the steps show beside the admin cards, as booleans
 * and variable NAMES only. Never a value.
 */
export interface ServerSetupFacts {
  oidc: { configured: boolean; only: boolean };
  smtp: { configured: boolean; missing: string[] };
  telegram: { webhookSecret: boolean };
}

/** What `GET /api/admin/server-setup` answers. */
export interface ServerSetupState {
  /**
   * Whether the setup is offered at all: false on a demo deploy, where the
   * screens refuse and no notice or line points at them.
   */
  offered: boolean;
  completedAt: string | null;
  steps: ServerSetupStepState[];
  /** The start-page notice shows while this is true (per admin). */
  noticePending: boolean;
  facts: ServerSetupFacts;
}
