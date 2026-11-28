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

/**
 * The steps, in the order the setup asks them (1.50). The owner account
 * itself is created on `/auth/register` before any of these; `account-mfa`
 * is its second factor, the rest are one decision each.
 */
export const SERVER_SETUP_STEP_IDS = [
  "account-mfa",
  "signups",
  "relay",
  "ai",
  "recovery",
] as const;

export type ServerSetupStepId = (typeof SERVER_SETUP_STEP_IDS)[number];

/**
 * The 1.49 step ids, read as their 1.50 successors so a setup that was open
 * across the upgrade resumes where it stood. `privacy` has no successor: its
 * cards stay under Admin.
 */
const LEGACY_STEP_IDS: Readonly<Record<string, ServerSetupStepId>> = {
  accounts: "signups",
  notifications: "relay",
  ai: "ai",
  health: "recovery",
};

export const SERVER_SETUP_STEP_STATUSES = [
  "pending",
  "done",
  "skipped",
] as const;

export type ServerSetupStepStatus = (typeof SERVER_SETUP_STEP_STATUSES)[number];

export interface ServerSetupStepState {
  id: ServerSetupStepId;
  status: ServerSetupStepStatus;
  /**
   * When a step was passed with "Later" or "Not now", and by whom. Only a
   * pass the admin made carries these: the second-factor banner and the
   * recovery kit banner wait for that answer, never for an inferred one.
   */
  at?: string;
  by?: string;
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
 *
 * A 1.49 setup that was still open is read through its old ids. It never had
 * a second-factor step, and asking it now would be the second time for an
 * owner who already met the policy elsewhere: it reads as passed, without
 * an `at`, so no banner waits on it.
 */
export function parseServerSetupSteps(value: unknown): ServerSetupStepState[] {
  const stored = new Map<string, ServerSetupStepState>();
  let legacy = false;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) continue;
      const raw = entry as {
        id?: unknown;
        status?: unknown;
        at?: unknown;
        by?: unknown;
      };
      if (
        typeof raw.id !== "string" ||
        typeof raw.status !== "string" ||
        !(SERVER_SETUP_STEP_STATUSES as readonly string[]).includes(raw.status)
      ) {
        continue;
      }
      const current = isServerSetupStepId(raw.id) ? raw.id : null;
      const id = current ?? LEGACY_STEP_IDS[raw.id];
      if (!current && (id || raw.id === "privacy")) legacy = true;
      if (!id || (current === null && stored.has(id))) continue;
      stored.set(id, {
        id,
        status: raw.status as ServerSetupStepStatus,
        ...(typeof raw.at === "string" ? { at: raw.at } : {}),
        ...(typeof raw.by === "string" ? { by: raw.by } : {}),
      });
    }
  }
  if (legacy && !stored.has("account-mfa")) {
    stored.set("account-mfa", { id: "account-mfa", status: "skipped" });
  }
  return SERVER_SETUP_STEP_IDS.map(
    (id) => stored.get(id) ?? { id, status: "pending" },
  );
}

/** One step answered or passed; the others stay as they were. */
export function applyServerSetupStep(
  steps: readonly ServerSetupStepState[],
  id: ServerSetupStepId,
  status: Exclude<ServerSetupStepStatus, "pending">,
  pass?: { at: string; by: string },
): ServerSetupStepState[] {
  return steps.map((step) =>
    step.id === id
      ? { id, status, ...(status === "skipped" && pass ? pass : {}) }
      : step,
  );
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
  return steps.find((step) => step.status === "pending")?.id ?? "account-mfa";
}

/** The stepper's segments: the owner account, then one per decision. */
export const SERVER_SETUP_SEGMENTS = [
  "account",
  "signups",
  "relay",
  "ai",
  "recovery",
] as const;

export type ServerSetupSegment = (typeof SERVER_SETUP_SEGMENTS)[number];

/**
 * Where a step stands on the stepper. The "account" segment has two parts:
 * the owner account itself (`/auth/register`, `"register"` here) fills half
 * of it, the second factor the rest.
 */
export function serverSetupStepper(step: ServerSetupStepId | "register"): {
  segments: readonly ServerSetupSegment[];
  segment: ServerSetupSegment;
  current: number;
  fraction: number;
} {
  const segment: ServerSetupSegment =
    step === "register" || step === "account-mfa" ? "account" : step;
  return {
    segments: SERVER_SETUP_SEGMENTS,
    segment,
    current: SERVER_SETUP_SEGMENTS.indexOf(segment),
    fraction: step === "register" ? 0.5 : 1,
  };
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
  /**
   * The notice shows while this is true (per admin): the setup is not
   * finished, or the push relay is still undecided.
   */
  noticePending: boolean;
  facts: ServerSetupFacts;
}
