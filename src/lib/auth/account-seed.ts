/**
 * The account seed: the part of the `/api/auth/me` payload the root layout
 * writes into a session-gated page so the shell paints without waiting for
 * its own `/api/auth/me` read.
 *
 * The HTML of a page is a copy of whatever it carries, held by every cache
 * between the server and the screen, so the seed carries only what the first
 * paint reads: the identity the shell shows, the gates (modules, AI, the
 * record session, sharing), the display preferences and the setup state.
 * Identity documents and anything only a settings form reads stay out: the
 * insurance fields, the full legal name, the date of birth and the saved
 * report choices. Those arrive with the shell's background `/api/auth/me`
 * read, which runs on every page load (the seed is stamped stale), and the
 * readers that seed a form from them wait for it (`useAuth().profileLoaded`).
 *
 * Allowlist, not denylist: `toAccountSeed` copies the fields named in
 * `ACCOUNT_SEED_FIELDS` and nothing else, and every field of the payload has
 * to be named in exactly one of the two lists below, or this module does not
 * type-check. A new `/me` field therefore cannot reach the document unseen.
 */
import type { MePayload } from "@/hooks/use-auth";
import type { buildAuthMePayload } from "@/lib/auth/me-payload";

type MeField = keyof Awaited<ReturnType<typeof buildAuthMePayload>>;

/** Fields the first paint reads; copied into the seed as they are. */
export const ACCOUNT_SEED_FIELDS = [
  "id",
  "username",
  "createdAt",
  "email",
  "role",
  "heightCm",
  "gender",
  "timezone",
  "onboardingCompletedAt",
  "onboardingTourCompleted",
  "onboarding",
  "disclaimerAcknowledgedAt",
  "disclaimerAcknowledgedVersion",
  "onboardingTourProgress",
  "avatarUrl",
  "glucoseUnit",
  "unitPreference",
  "timeFormat",
  "dateFormat",
  "medicineRegistry",
  "notificationPrefs",
  "disableCoach",
  "displayName",
  "cycleTrackingEnabled",
  "modules",
  "moduleAvailability",
  "moduleAccess",
  "ai",
  "coachReasoning",
  "accountAccess",
  "recordSession",
  "features",
  "push",
] as const satisfies readonly MeField[];

/**
 * Fields that never enter a document. They are written into the seed as
 * `null`, beside `accountSeed: true`, so a reader can tell "not loaded yet"
 * from "not set" (`useAuth().profileLoaded`).
 */
export const ACCOUNT_SEED_WITHHELD = [
  "dateOfBirth",
  "fullName",
  "insurerName",
  "insurerIkNumber",
  "insuranceNumber",
  "lastReportPracticeName",
  "reportSelection",
] as const satisfies readonly MeField[];

type SeedField = (typeof ACCOUNT_SEED_FIELDS)[number];
type WithheldField = (typeof ACCOUNT_SEED_WITHHELD)[number];

/**
 * Compile-time completeness: a payload field in neither list fails here with
 * its name in the error, and a field in both lists fails the second check.
 */
type Unclassified = Exclude<MeField, SeedField | WithheldField>;
const everyFieldClassified: [Unclassified] extends [never]
  ? true
  : { unclassified: Unclassified } = true;
type DoublyClassified = Extract<SeedField, WithheldField>;
const noFieldInBothLists: [DoublyClassified] extends [never]
  ? true
  : { inBothLists: DoublyClassified } = true;
void everyFieldClassified;
void noFieldInBothLists;

export type AccountSeed = MePayload & { [K in WithheldField]: null } & {
  accountSeed: true;
};

/**
 * Project a `/me` payload (wire shape) onto the seed. Fields outside the
 * allowlist are dropped, including ones a future payload adds; the withheld
 * fields are written as `null` with the seed marker.
 */
export function toAccountSeed(payload: MePayload): AccountSeed {
  const source = payload as Record<string, unknown>;
  const seed: Record<string, unknown> = {};
  for (const field of ACCOUNT_SEED_FIELDS) {
    if (Object.hasOwn(source, field)) seed[field] = source[field];
  }
  for (const field of ACCOUNT_SEED_WITHHELD) seed[field] = null;
  seed.accountSeed = true;
  return seed as AccountSeed;
}
