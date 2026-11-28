/**
 * The resolved setup state both clients render (1.50), as published by
 * `GET /api/setup`. Pure: the OpenAPI registry, the web card and the
 * resolver read the same vocabulary.
 *
 * The server decides everything here: which segments a person's flow has,
 * where they stand, which rows the setup card lists and what each says. A
 * client renders it and never recomputes it. Every id list is closed; a
 * client that meets an id it does not know skips it.
 */
import {
  PERSON_SCREEN_IDS,
  PERSON_SEGMENT_IDS,
} from "@/lib/onboarding/wizard-steps";
import {
  SERVER_SETUP_STEP_IDS,
  SERVER_SETUP_STEP_STATUSES,
} from "@/lib/admin/server-setup";

export { PERSON_SCREEN_IDS, PERSON_SEGMENT_IDS, SERVER_SETUP_STEP_IDS };

/** The rows of a person's setup card (and Settings › Account › Setup). */
export const PERSON_TASK_IDS = [
  "resume",
  "medication",
  "second-factor",
  "about-you",
  "reading",
  "source",
  "second-channel",
  "coach",
  "managed-profile",
] as const;

export type PersonTaskId = (typeof PERSON_TASK_IDS)[number];

/** The rows of Admin › Setup. */
export const INSTANCE_TASK_IDS = [
  "second-factor",
  "signups",
  "relay",
  "ai",
  "recovery",
  "email",
  "sso",
  "services",
  "backups",
  "error-reporting",
] as const;

export type InstanceTaskId = (typeof INSTANCE_TASK_IDS)[number];

/**
 * A row's state: `todo` waits for the person; `done` is set up; `declined`
 * is an explicit no, which counts as settled and is never asked again;
 * `warning` is a detected problem or a deadline under seven days.
 */
export const SETUP_TASK_STATUSES = [
  "todo",
  "done",
  "declined",
  "warning",
] as const;

export type SetupTaskStatus = (typeof SETUP_TASK_STATUSES)[number];

/**
 * The value a settled row shows, as a closed vocabulary the client
 * translates (`setup.values.<value>`), or null.
 */
export const SETUP_TASK_VALUES = [
  "on",
  "off",
  "passkey",
  "authenticator",
  "invited",
  "anyone",
  "own-keys",
  "server-key",
  "central-account",
  "saved",
  "key-added",
  "add-key",
] as const;

export type SetupTaskValue = (typeof SETUP_TASK_VALUES)[number];

export interface SetupTask<Id extends string = string> {
  id: Id;
  status: SetupTaskStatus;
  value: SetupTaskValue | null;
  /** ISO instant of a deadline (the second-factor policy), or null. */
  deadline: string | null;
  /**
   * The deadline's calendar day (`YYYY-MM-DD`) in the profile's time zone,
   * the day to show; null without a deadline.
   */
  deadlineDate: string | null;
  /** The IANA zone the deadline is read in (the profile's); null without one. */
  deadlineTimeZone: string | null;
  /** "3 of 6"-style counts for a row that is a group, or null. */
  count: { done: number; total: number } | null;
}

export type SetupScreenStatus = "pending" | "done" | "skipped";

export interface PersonSetupState {
  /**
   * The first run is still owed: the account has not been stamped complete,
   * which is the same gate the web's first-run redirect follows. A client
   * shows its setup flow exactly when this is true.
   */
  firstRunOwed: boolean;
  /** `done` once every screen of the flow is answered or passed. */
  status: "pending" | "done";
  /** The screen the flow resumes on, or null when nothing is owed. */
  currentStep: (typeof PERSON_SCREEN_IDS)[number] | null;
  segments: Array<{
    id: (typeof PERSON_SEGMENT_IDS)[number];
    screens: Array<{
      id: (typeof PERSON_SCREEN_IDS)[number];
      status: SetupScreenStatus;
    }>;
  }>;
  /**
   * The flow started on this release, so its segments are pinned. Such an
   * account gets the setup card; an older account keeps the getting-started
   * checklist it had.
   */
  planned: boolean;
  /**
   * Whether the dashboard shows the setup card: a planned account with an
   * open row that has not hidden the card.
   */
  cardShown: boolean;
  cardDismissed: boolean;
  tasks: Array<SetupTask<PersonTaskId>>;
}

export interface InstanceSetupState {
  status: "pending" | "done";
  currentStep: (typeof SERVER_SETUP_STEP_IDS)[number] | null;
  steps: Array<{
    id: (typeof SERVER_SETUP_STEP_IDS)[number];
    status: (typeof SERVER_SETUP_STEP_STATUSES)[number];
  }>;
  tasks: Array<SetupTask<InstanceTaskId>>;
}

export interface SetupStateDto {
  person: PersonSetupState;
  /** Admins on a browser session only; null otherwise. */
  instance: InstanceSetupState | null;
  offers: {
    relay: "on" | "off" | "undecided";
    ai: boolean;
  };
}
