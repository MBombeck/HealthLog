/**
 * Structural guard on destructive controls: nothing that can take a person's
 * data away ships without someone having written down what it takes and what
 * gates it.
 *
 * WHY A REGISTRY RATHER THAN A PATTERN MATCH
 *
 * The obvious guard — "every `Trash2` trigger must sit next to an
 * `AlertDialog`" — fails in both directions, and it fails quietly. It misses
 * the control that destroys the most: Settings → AI cleared a person's
 * free-text note AND their allergy line from one untargeted tap, through a
 * `PUT` carrying two empty strings, with no trash icon involved in the write
 * and nothing in the payload spelling "delete". It cries wolf on the reverse:
 * a `Trash2` that removes a row from an unsaved draft, a "reset" that only
 * touches local state until a separate Save, an undo affordance inside a
 * success toast. Both classes are live in this tree. A guard that has to be
 * suppressed on half its hits teaches people to suppress it.
 *
 * So the honest shape is: the REGISTRY below is the source of truth for what
 * is destructive, because that judgement is not mechanical. Three detectors
 * then make FORGETTING TO REGISTER the failure mode — each is complete for
 * its own syntactic shape, and together they cover every way this codebase
 * currently issues a destroying request:
 *
 *   D1  a DELETE goes out            `apiDelete(…)` / `method: "DELETE"`
 *   D2  a route whose own name is the act  `/api/…/{disconnect,revoke,reset,
 *                                           purge,clear,wipe,bulk-delete}`
 *   D3  a write blanks a stored field      a payload literal assigning `""`
 *                                           or `null` to a named key
 *
 * WHAT THIS CANNOT DO — stated plainly, because a guard that oversells itself
 * is worse than none:
 *
 *   - It cannot prove the registry is COMPLETE. A destructive control that
 *     issues no DELETE, hits no act-named route, and blanks no literal field —
 *     a PUT that overwrites a list with a shorter one, say — is invisible to
 *     all three detectors and will not be caught by anything here.
 *   - It cannot prove a registered claim is TRUE. `confirm: ["ConfirmButton"]`
 *     is checked only to the extent that the named mechanism is present in one
 *     of the entry's files. A reviewer who waves through a wrong entry defeats
 *     it, and no test substitutes for that review.
 *   - `unconfirmed` entries are the escape hatch, and they are deliberately
 *     expensive: each needs a written reason long enough to be an argument
 *     rather than a shrug. There is no silent skip.
 *
 * What it does hold: a new destructive control cannot land unnoticed, a
 * removed one cannot leave a lie behind, and the specific regression that
 * started this — a destroying payload fired straight from an `onClick` — goes
 * red at the call site.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

type ConfirmKind =
  | "ConfirmButton"
  | "ConfirmDialog"
  | "DeleteButton"
  | "SelectionActionBar"
  | "AlertDialog"
  | "inline-two-step"
  | "typed-phrase";

/**
 * How bounded the loss is. This is the axis that decides whether a control
 * wants a confirmation, an undo, or both, so the registry makes the next
 * person answer it rather than leaving it implied.
 *
 *   permanent             a column overwritten, or a row hard-deleted.
 *                         Nothing in the product brings it back.
 *   tombstoned-no-restore soft-deleted in the database, but no restore route
 *                         and no surface a person could reach it from. Gone,
 *                         as far as the person is concerned.
 *   restorable            a restore route exists AND a control reaches it.
 */
type Recovery = "permanent" | "tombstoned-no-restore" | "restorable";

interface DestructiveEntry {
  /** Path under `src/`, forward slashes. Where the destroying request lives. */
  file: string;
  /** Plain words: what a person loses. */
  destroys: string;
  /** Files carrying the trigger, when the mutation lives in a hook. */
  triggers?: string[];
  recovery: Recovery;
  /** Mechanisms gating the triggers. Empty only alongside `unconfirmed`. */
  confirm: ConfirmKind[];
  /**
   * Controls in this entry that deliberately do NOT confirm. Every one needs
   * an argument, not a note — the length floor is enforced below.
   */
  unconfirmed?: { control: string; reason: string }[];
  /**
   * Set when the entry is deliberately kept although no detector sees it —
   * the concrete form of "this guard cannot prove the registry is complete".
   * The value says which shape slips past, so the blind spot is on the record
   * instead of being inferred from an absent row.
   */
  undetected?: string;
}

const REGISTRY: DestructiveEntry[] = [
  // ── Account, credentials, sessions ──────────────────────────────────────
  {
    file: "components/settings/advanced-section.tsx",
    destroys:
      "every health record on the account, or the whole account including passkeys and audit history",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/settings/security-sessions-card.tsx",
    destroys: "one login session, or every session other than this one",
    recovery: "permanent",
    confirm: ["ConfirmButton"],
  },
  {
    file: "components/settings/trusted-devices-card.tsx",
    destroys: "the second-factor memory for one device, or for all of them",
    recovery: "permanent",
    confirm: ["ConfirmButton"],
  },
  {
    file: "components/settings/security-section/passkey-list-section.tsx",
    destroys: "a passkey — hard-deleted, the credential cannot be re-derived",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/settings/security-section/security-keys-card.tsx",
    destroys: "a WebAuthn second factor",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/settings/api-section.tsx",
    destroys: "an API token — revoked, and the secret is never shown again",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/settings/mcp-section.tsx",
    destroys: "an MCP client grant or an MCP token",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/settings/sharing-section.tsx",
    destroys: "a clinician share link — the URL stays dead once revoked",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/settings/account-section/avatar-section.tsx",
    destroys: "the uploaded profile photo, deleted from the server",
    recovery: "permanent",
    confirm: ["ConfirmButton"],
  },

  // ── AI credentials ──────────────────────────────────────────────────────
  {
    file: "components/settings/ai/codex-provider-form.tsx",
    destroys: "the stored Codex sign-in and the cached insight text with it",
    recovery: "permanent",
    confirm: ["ConfirmButton"],
  },
  {
    file: "components/admin/central-codex-section.tsx",
    destroys:
      "the instance-wide shared AI sign-in — every user relying on it loses AI features",
    recovery: "permanent",
    confirm: ["ConfirmButton"],
  },
  {
    file: "components/admin/ai-server-key-section.tsx",
    destroys:
      "the operator-wide AI provider key, which is never displayed again once stored",
    recovery: "permanent",
    confirm: ["ConfirmButton"],
  },
  {
    file: "components/settings/ai/ai-consent-card.tsx",
    destroys: "the AI consent receipt that gates every AI surface",
    recovery: "restorable",
    confirm: ["inline-two-step"],
  },
  {
    file: "components/records/about-me-note-manager.tsx",
    destroys: "the free-text self-context note the Coach and briefing read",
    recovery: "permanent",
    confirm: ["ConfirmButton"],
  },
  {
    file: "components/settings/coach-memory-section.tsx",
    destroys: "one remembered Coach fact, or every one of them",
    recovery: "tombstoned-no-restore",
    confirm: ["ConfirmButton", "AlertDialog"],
  },
  {
    file: "hooks/use-coach-reminders.ts",
    destroys: "a Coach reminder",
    triggers: ["components/settings/coach-reminders-section.tsx"],
    recovery: "tombstoned-no-restore",
    confirm: ["ConfirmButton"],
  },
  {
    file: "hooks/use-coach-plans.ts",
    destroys: "a Coach plan and the record of how it went",
    triggers: [
      "app/coach/plans/page.tsx",
      "components/insights/coach-panel/plan-proposal-card.tsx",
    ],
    recovery: "tombstoned-no-restore",
    confirm: ["ConfirmButton"],
    unconfirmed: [
      {
        control:
          "decline a PROPOSED plan — app/coach/plans/page.tsx and plan-proposal-card.tsx",
        reason:
          "Declining is the negative half of an accept/decline pair the assistant just offered; the person has invested nothing in a proposal they never adopted, and the same suggestion re-derives on a later turn. Confirming a refusal would make saying no more expensive than saying yes. The delete of a plan the person actually RAN is confirmed, and that is the one carrying history.",
      },
    ],
  },
  {
    file: "components/insights/coach-panel/use-coach.ts",
    destroys: "a whole Coach conversation and every message in it",
    triggers: [
      "components/insights/coach-panel/history-rail.tsx",
      "app/coach/conversations/page.tsx",
    ],
    recovery: "permanent",
    confirm: [],
    unconfirmed: [
      {
        control:
          "delete conversation — history-rail.tsx and conversations page",
        reason:
          "This surface deliberately chose undo over confirmation: the delete is held for a few seconds behind an undo toast, and the earlier arm-then-confirm double tap was removed on purpose. Adding a dialog back would give the same act two gates. The pending-delete flush on unmount is a real hole in that promise and is tracked separately; it is a defect in the undo, not an argument for a confirmation.",
      },
    ],
  },
  {
    file: "components/insights/coach-panel/coach-conversation.tsx",
    destroys:
      "the stored list of pending clarifying questions, and document attachments on a conversation",
    recovery: "permanent",
    confirm: [],
    unconfirmed: [
      {
        control: "dismiss questions; detach a document",
        reason:
          "Neither touches something the person wrote. The questions are assistant-generated suggestions that the extractor regenerates on later turns, and dismissing them IS the affordance. Detaching removes a join row only — the document itself stays in the vault and is two taps from being re-attached.",
      },
    ],
  },

  // ── Preferences and layout a person arranged by hand ─────────────────────
  {
    file: "components/settings/thresholds-editor-section.tsx",
    destroys: "the custom range set for one metric, or for every metric",
    recovery: "permanent",
    confirm: ["ConfirmButton", "ConfirmDialog"],
  },
  {
    file: "components/targets/target-edit-sheet.tsx",
    destroys:
      "the custom target range for one metric — both halves at once for blood pressure",
    recovery: "permanent",
    confirm: ["ConfirmButton"],
  },
  {
    file: "components/settings/dashboard-layout-section.tsx",
    destroys:
      "the dashboard arrangement: tile order, hidden tiles, ring choice",
    recovery: "permanent",
    confirm: ["ConfirmButton"],
  },
  {
    file: "components/insights/insights-edit-mode.tsx",
    destroys: "the Insights overview arrangement: section order and visibility",
    recovery: "permanent",
    confirm: ["ConfirmButton"],
  },
  {
    file: "components/settings/environment-section.tsx",
    destroys: "a saved travel location",
    recovery: "permanent",
    confirm: ["ConfirmButton"],
  },
  {
    file: "components/settings/web-push-card.tsx",
    destroys: "the browser push subscription row",
    recovery: "restorable",
    confirm: [],
    unconfirmed: [
      {
        control: "unsubscribe from push notifications",
        reason:
          "This is the off half of a notification channel toggle. Re-subscribing from the same control recreates the row, nothing the person authored is stored in it, and the browser permission survives. Gating it would put a dialog on a switch.",
      },
    ],
  },

  // ── Measurements, mood, labs, illness — the undo-and-restore surfaces ────
  {
    file: "components/measurements/measurement-list.tsx",
    destroys: "one measurement, or every selected measurement",
    recovery: "restorable",
    confirm: ["DeleteButton", "SelectionActionBar", "AlertDialog"],
  },
  {
    file: "components/mood/mood-list.tsx",
    destroys: "one mood entry, or every selected mood entry",
    recovery: "restorable",
    confirm: ["DeleteButton", "SelectionActionBar", "AlertDialog"],
  },
  {
    file: "components/labs/lab-history-list.tsx",
    destroys: "one lab reading",
    recovery: "restorable",
    confirm: ["DeleteButton"],
  },
  {
    file: "components/illness/use-illness.ts",
    destroys: "an illness episode with its day logs and notes",
    triggers: ["components/illness/episode-menu.tsx"],
    recovery: "restorable",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/symptoms/use-symptoms.ts",
    destroys:
      "one logged symptom entry, or a person-defined symptom with every entry of it",
    triggers: ["components/symptoms/symptoms-section.tsx"],
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/labs/biomarker-manager.tsx",
    destroys: "a biomarker AND every lab reading recorded against it",
    recovery: "permanent",
    confirm: ["DeleteButton"],
  },
  {
    file: "components/labs/lab-biomarker-detail.tsx",
    destroys: "a biomarker AND every lab reading recorded against it",
    recovery: "permanent",
    confirm: ["DeleteButton"],
  },
  {
    file: "components/custom-metrics/custom-metric-detail.tsx",
    destroys: "a custom metric definition",
    recovery: "tombstoned-no-restore",
    confirm: ["DeleteButton"],
  },
  {
    file: "components/custom-metrics/custom-metric-history-list.tsx",
    destroys: "one custom-metric reading",
    recovery: "permanent",
    confirm: ["DeleteButton"],
  },
  {
    file: "components/records/allergy-manager.tsx",
    destroys: "one allergy record",
    recovery: "permanent",
    confirm: ["DeleteButton"],
  },
  {
    file: "components/records/family-history-manager.tsx",
    destroys: "one family-history entry",
    recovery: "tombstoned-no-restore",
    confirm: ["DeleteButton"],
  },
  {
    file: "components/records/health-profile-facts-manager.tsx",
    destroys: "the current value of one effective-dated health-profile fact",
    recovery: "tombstoned-no-restore",
    confirm: ["ConfirmButton"],
  },
  {
    file: "hooks/use-measurement-reminders.ts",
    destroys: "a checkup or measurement reminder with its schedule",
    triggers: ["components/measurement-reminders/vorsorge-section.tsx"],
    recovery: "tombstoned-no-restore",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/workouts/delete-workout-button.tsx",
    destroys:
      "one workout entered by hand, with the personal records it set; synced workouts are refused by the route",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },

  // ── Visits and the address book ─────────────────────────────────────────
  {
    file: "hooks/use-encounters.ts",
    destroys:
      "a visit with its reason, outcome and the links it collected — and, for a booked one, the appointment reminder that would have nudged about it",
    triggers: ["components/encounters/encounter-sheet.tsx"],
    // The route soft-deletes and a restore route exists, but nothing in the
    // product reaches it yet, so from a person's side the visit is gone. This
    // becomes "restorable" the day a surface offers the undo, not before.
    recovery: "tombstoned-no-restore",
    confirm: ["AlertDialog"],
  },
  {
    file: "hooks/use-practitioners.ts",
    destroys: "one address-book entry",
    triggers: ["components/practitioners/practitioner-list.tsx"],
    recovery: "tombstoned-no-restore",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/vaccinations/use-vaccinations.ts",
    destroys:
      "one logged dose with its lot, site and the document links it collected — the booster reminder it once satisfied is deliberately not rewound",
    triggers: ["components/vaccinations/vaccination-sheet.tsx"],
    // The route soft-deletes and a restore route exists, but no surface offers
    // the undo yet, so from a person's side the dose is gone.
    recovery: "tombstoned-no-restore",
    confirm: ["AlertDialog"],
  },

  // ── Cycle ───────────────────────────────────────────────────────────────
  {
    file: "components/cycle/use-cycle.ts",
    destroys:
      "a whole logged cycle day — flow, temperature, symptoms, note — or a custom symptom from the catalogue",
    triggers: ["components/cycle/log-day-sheet.tsx"],
    recovery: "tombstoned-no-restore",
    confirm: ["ConfirmButton", "ConfirmDialog"],
  },

  // ── Medications ─────────────────────────────────────────────────────────
  {
    file: "components/medications/sections/destructive-zone-section.tsx",
    destroys:
      "every intake event for a medication, or the medication with its schedules and inventory",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/medications/intake-history-editable.tsx",
    destroys: "one intake event, or every selected intake event",
    triggers: ["components/medications/intake-history-list-v2.tsx"],
    recovery: "tombstoned-no-restore",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/medications/dose-history-ledger.tsx",
    destroys: "one intake event",
    recovery: "tombstoned-no-restore",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/medications/side-effects-section.tsx",
    destroys: "one side-effect log entry",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/medications/sections/inventory-section.tsx",
    destroys: "one inventory pack record",
    recovery: "permanent",
    confirm: ["DeleteButton"],
  },
  {
    file: "components/medications/scheduling/schedule-history-timeline.tsx",
    destroys: "one schedule revision, re-segmenting the dosing history",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/medications/use-medication-categories.ts",
    destroys:
      "one of the person's own medication categories; the medications filed under it move to Other, they are not deleted",
    triggers: ["components/medications/medication-categories-sheet.tsx"],
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/medications/sections/courses-section.tsx",
    destroys:
      "one course of a medication (its dates and note); the intakes logged in it stay, and deleting the only course makes the medication continuous again",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/medications/use-medication-intake.ts",
    destroys: "an intake event recorded seconds ago",
    recovery: "tombstoned-no-restore",
    confirm: [],
    unconfirmed: [
      {
        control: "Undo inside the intake success toast",
        reason:
          "This IS the undo for a create the person made a moment earlier, reached only from that create's own toast. Confirming an undo would ask someone to confirm a correction, which inverts what the affordance is for.",
      },
    ],
  },

  // ── Mood tags ───────────────────────────────────────────────────────────
  {
    file: "components/mood/manage/archived-tags-card.tsx",
    destroys:
      "an archived custom mood tag AND every mood entry's link to it, by cascade",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/mood/manage/tag-groups-card.tsx",
    destroys: "a custom mood tag group (its member tags are rehomed, not lost)",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },

  // ── Documents ───────────────────────────────────────────────────────────
  {
    file: "components/documents/document-detail-sheet.tsx",
    destroys: "one document in the vault",
    recovery: "restorable",
    confirm: [],
    unconfirmed: [
      {
        control: "Delete in the document detail sheet",
        reason:
          "Documents chose undo over confirmation across every one of its delete paths, and it is the one domain where that choice is fully backed: the row is soft-deleted, a restore route exists, and the success toast carries the undo that calls it. Layering a dialog on top would gate a reversible act on the surface that already handles reversibility best.",
      },
    ],
  },
  {
    file: "components/documents/documents-view.tsx",
    destroys: "every selected document, or one document from a focused card",
    triggers: [
      "components/documents/document-bulk-bar.tsx",
      "components/documents/document-card.tsx",
    ],
    recovery: "restorable",
    confirm: [],
    undetected:
      'The bulk route is POST /api/documents/inbound/bulk with the verb in the body ({ action: "delete" }), so no detector sees it: no DELETE goes out, the path names no act, and nothing is blanked. Registered by hand.',
    unconfirmed: [
      {
        control: "bulk delete, and the Delete/Backspace key on a focused card",
        reason:
          "Same undo-not-confirmation choice as the detail sheet, and the bulk path raises one aggregate undo for the whole batch. The keyboard path is the weakest link in that argument, since a keystroke needs no aim and the undo lives only in a toast with no trash view behind it; it is recorded here rather than silently accepted, and closing it means giving documents a recovery surface, not a dialog.",
      },
    ],
  },

  // ── Account sharing ─────────────────────────────────────────────────────
  {
    file: "components/settings/access/grants-given-card.tsx",
    destroys:
      "another account's standing access to this health record, and every browser session of theirs that was inside it",
    recovery: "permanent",
    confirm: ["ConfirmButton"],
    undetected:
      "No detector sees it. The DELETE goes out from `useRevokeGrant` in `lib/queries/use-account-grants.ts`, and `lib/` is an excluded root; the card itself only calls `.mutate(grant.id)` with a bare string, which no payload pattern matches, and the route path lives in the hook rather than here. Registered by hand.",
  },
  {
    file: "components/settings/access/grants-received-card.tsx",
    destroys:
      "this account's own access to somebody else's record, handed back rather than withdrawn",
    recovery: "permanent",
    confirm: ["ConfirmButton"],
    undetected:
      "Same shape as the card above, and one step further out of reach: renouncing is a POST, so not even a DELETE goes out. The path (`/api/account/grants/{id}/renounce`) names an act the D2 vocabulary does not carry, and it lives in the hook regardless. Registered by hand.",
  },

  // ── Admin ───────────────────────────────────────────────────────────────
  {
    file: "components/admin/danger-zone-section.tsx",
    destroys: "every user's records on the instance",
    recovery: "permanent",
    confirm: ["typed-phrase"],
  },
  {
    file: "components/admin/invite-tokens-section.tsx",
    destroys: "an unredeemed invite token — the link stays dead",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
  {
    file: "components/admin/user-management-section.tsx",
    destroys: "another user's sessions, or their stored password hash",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },

  // ── Integrations ────────────────────────────────────────────────────────
  ...(
    [
      ["withings-card.tsx", "Withings"],
      ["fitbit-card.tsx", "Fitbit"],
      ["whoop-card.tsx", "WHOOP"],
      ["google-health-card.tsx", "Google Health"],
      ["nightscout-card.tsx", "Nightscout"],
      ["oauth-provider-card.tsx", "the generic OAuth providers"],
    ] as const
  ).map(([f, name]): DestructiveEntry => ({
    file: `components/settings/integrations/${f}`,
    destroys: `the stored ${name} credentials — reconnecting means authorising again`,
    recovery: "permanent",
    confirm: ["AlertDialog"],
  })),
  {
    file: "components/settings/integrations/document-sources-card.tsx",
    destroys:
      "the stored Paperless-ngx or Papra address and API token; documents already imported stay in the vault — reconnecting means typing the token again",
    recovery: "permanent",
    confirm: ["AlertDialog"],
  },
];

// ── Detectors ─────────────────────────────────────────────────────────────

/** D1 — a DELETE request goes out. */
const D1 = /apiDelete[<(]|method:\s*"DELETE"/;
/** D2 — a route path whose own name is the destructive act. */
const D2 =
  /["`]\/api\/[^"`?\s]*(?:disconnect|revoke|reset|purge|clear|wipe|bulk-delete)[^"`?\s]*/;
/** D3 — a write payload that blanks a named field. */
const D3 =
  /(?:\.mutate|\.mutateAsync|apiPut|apiPatch|apiPost)[<(]?\(\s*(?:"[^"]*",\s*)?\{[^{}]*?\b\w+:\s*(?:""|null)/;

/**
 * Where a destructive CONTROL can live. Route handlers are the other end of
 * the wire, not a control, and `src/lib` holds no JSX — its three matches are
 * the `apiDelete` helper itself, an audit-path string constant and an OpenAPI
 * path literal. Both exclusions are asserted below so neither can be widened
 * into a hiding place without this test noticing.
 */
const CONTROL_ROOTS = ["app/", "components/", "hooks/"];
const EXCLUDED_PREFIXES = ["app/api/", "generated/", "lib/"];

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

function isControlFile(rel: string): boolean {
  if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) return false;
  return CONTROL_ROOTS.some((p) => rel.startsWith(p));
}

function detect(rel: string): string[] {
  const src = read(rel);
  const tags: string[] = [];
  if (D1.test(src)) tags.push("D1");
  if (D2.test(src)) tags.push("D2");
  if (D3.test(src)) tags.push("D3");
  return tags;
}

let detectedCache: string[] | null = null;
function detectedFiles(): string[] {
  detectedCache ??= sourceFiles().filter(
    (rel) => isControlFile(rel) && detect(rel).length,
  );
  return detectedCache;
}

const CONFIRM_MARKERS: Record<ConfirmKind, RegExp> = {
  ConfirmButton: /<ConfirmButton\b/,
  ConfirmDialog: /<ConfirmDialog\b/,
  DeleteButton: /<DeleteButton\b/,
  SelectionActionBar: /<SelectionActionBar\b/,
  AlertDialog: /<AlertDialogAction\b/,
  // A confirm step rendered in place rather than in a dialog: the first tap
  // swaps the control for an explanation plus a separate, differently-labelled
  // confirm button. Marked by the `-confirm` slot that second button carries.
  "inline-two-step": /data-slot="[\w-]+-confirm"/,
  // An admin-grade gate: the exact word has to be typed before the action arms.
  "typed-phrase": /CONFIRM_TOKEN|confirmText|typedConfirm/,
};

const byFile = new Map(REGISTRY.map((e) => [e.file, e]));

describe("T1 — every destructive control is registered", () => {
  it("the registry names every file the detectors flag", () => {
    const missing = detectedFiles().filter((rel) => !byFile.has(rel));
    expect(
      missing,
      "A destructive request is issued from these files and nothing in the " +
        "registry accounts for it. Add an entry naming what it destroys, how " +
        "recoverable that is, and what gates it — or, if it genuinely does " +
        "not destroy anything, say so under `unconfirmed` with the argument.",
    ).toEqual([]);
  });

  it("carries no stale entry", () => {
    const stale = REGISTRY.filter(
      (e) => !e.undetected && !detectedFiles().includes(e.file),
    ).map((e) => e.file);
    expect(
      stale,
      "These entries no longer match any detector. If the control was removed, " +
        "delete the entry; if it was rewritten into a shape the detectors " +
        "cannot see, that is worth knowing before the entry is dropped.",
    ).toEqual([]);
  });

  it("declares each file once", () => {
    expect(byFile.size).toBe(REGISTRY.length);
  });

  it("pins the detector exclusions so they cannot quietly widen", () => {
    // `src/lib` and the route handlers are excluded because a control cannot
    // live there. If that stops being true the exclusion is a hiding place.
    expect(EXCLUDED_PREFIXES).toEqual(["app/api/", "generated/", "lib/"]);
    expect(CONTROL_ROOTS).toEqual(["app/", "components/", "hooks/"]);
  });
});

describe("T2 — every registered control names a real gate", () => {
  for (const entry of REGISTRY) {
    describe(entry.file, () => {
      const files = [entry.file, ...(entry.triggers ?? [])];

      it("has a confirmation mechanism, or an argument for having none", () => {
        expect(
          entry.confirm.length > 0 || (entry.unconfirmed?.length ?? 0) > 0,
          `${entry.file}: neither a confirmation nor a reason for going without one`,
        ).toBe(true);
      });

      for (const kind of entry.confirm) {
        it(`the claimed ${kind} is actually present`, () => {
          const found = files.some((f) => CONFIRM_MARKERS[kind].test(read(f)));
          expect(
            found,
            `${entry.file} claims ${kind}, but no such control renders in ${files.join(" / ")}`,
          ).toBe(true);
        });
      }

      for (const skip of entry.unconfirmed ?? []) {
        it(`the case for leaving "${skip.control}" unconfirmed is written out`, () => {
          // A one-liner is a shrug. The floor is set where a sentence that
          // actually argues something has to be written.
          expect(
            skip.reason.trim().length,
            `${entry.file} → ${skip.control}: give the reason, not a note`,
          ).toBeGreaterThanOrEqual(120);
        });
      }

      it("every named trigger file exists", () => {
        for (const f of files) expect(() => read(f)).not.toThrow();
      });
    });
  }
});

describe("T3 — a destroying payload never fires straight from a handler", () => {
  /**
   * The regression that started this: `onClick={() => save.mutate({ aboutMe:
   * "", allergies: "" })}`. One tap, two fields blanked, no gate. This walks
   * every event-handler attribute in every registered file and fails if a
   * destroying request sits inline inside one — which is the shape that skips
   * the dialog by construction rather than by oversight.
   *
   * Indirection through a named handler (`onClick={handleDisconnect}`) is out
   * of reach here and is covered instead by T2's requirement that the file
   * render a confirmation at all. Named, so nobody reads more into this.
   */
  /**
   * Elements whose handlers ARE the confirmed path — the dialog's own action
   * button, and the primitives that own their dialog. A destroying call inside
   * one of these is the point, not the bug. Getting this list wrong in the
   * other direction is how a guard starts crying wolf, so it is short and
   * every member is a confirmation surface by construction.
   */
  const CONFIRMED_ELEMENTS = new Set([
    "AlertDialogAction",
    "ConfirmButton",
    "ConfirmDialog",
    "DeleteButton",
    "SelectionActionBar",
  ]);
  /** `onConfirm` is a confirmation callback wherever it appears. */
  const CONFIRMED_ATTRS = /^onConfirm$/;

  /**
   * Walk the JSX opening tags and hand back `[element, handlerAttr, body]` for
   * every event handler, so the check can tell a raw `onClick` on a `Button`
   * from the `onClick` the dialog's action button carries.
   */
  function handlers(src: string): { el: string; attr: string; body: string }[] {
    const out: { el: string; attr: string; body: string }[] = [];
    const TAG = /<([A-Z][\w.]*|[a-z][\w-]*)(?=[\s/>])/g;
    for (const tag of src.matchAll(TAG)) {
      const el = tag[1];
      // Scan to the end of THIS opening tag, tracking brace depth and strings
      // so an attribute expression containing `>` does not end it early.
      let i = tag.index + tag[0].length;
      let depth = 0;
      let quote: string | null = null;
      const attrs: { attr: string; body: string }[] = [];
      let pendingAttr: string | null = null;
      let bodyStart = 0;
      for (; i < src.length; i++) {
        const c = src[i];
        if (quote) {
          if (c === quote) quote = null;
          continue;
        }
        if (depth === 0 && (c === '"' || c === "'" || c === "`")) {
          quote = c;
          continue;
        }
        if (c === "{") {
          if (depth === 0) {
            const before = src.slice(Math.max(0, i - 60), i);
            const m = /\b(on[A-Z]\w*)=$/.exec(before);
            pendingAttr = m ? m[1] : null;
            bodyStart = i;
          }
          depth++;
          continue;
        }
        if (c === "}") {
          depth--;
          if (depth === 0 && pendingAttr) {
            attrs.push({
              attr: pendingAttr,
              body: src.slice(bodyStart, i + 1),
            });
            pendingAttr = null;
          }
          continue;
        }
        if (depth === 0 && c === ">") break;
      }
      for (const a of attrs) out.push({ el, ...a });
    }
    return out;
  }

  // Unconditional, including the entries that argue for having no dialog. The
  // whole registry is clean of this shape today, so there is no exemption to
  // carve out and no reason to leave a door open for one. A control that
  // genuinely should fire without a gate still has somewhere to go: the
  // confirmed elements above, or a named handler the file can be read at.
  for (const entry of REGISTRY) {
    const files = [entry.file, ...(entry.triggers ?? [])].filter((f) =>
      f.endsWith(".tsx"),
    );

    for (const file of files) {
      it(`${file} — no inline destroying handler`, () => {
        const offenders = handlers(read(file))
          .filter(
            (h) =>
              !CONFIRMED_ELEMENTS.has(h.el) && !CONFIRMED_ATTRS.test(h.attr),
          )
          .filter((h) => D1.test(h.body) || D3.test(h.body))
          .map((h) => `<${h.el} ${h.attr}=${h.body.slice(0, 80)}`);
        expect(
          offenders,
          `${file}: a destroying request fires directly from an event handler. ` +
            `Route it through ConfirmButton / ConfirmDialog / DeleteButton, or ` +
            `move it behind a named handler the reviewer can read.`,
        ).toEqual([]);
      });
    }
  }
});

describe("T4 — the registry answers the recoverability question", () => {
  it("every entry classifies what a person can get back", () => {
    for (const e of REGISTRY) {
      expect(
        ["permanent", "tombstoned-no-restore", "restorable"],
        e.file,
      ).toContain(e.recovery);
      expect(e.destroys.trim().length, e.file).toBeGreaterThan(10);
    }
  });

  it("nothing permanent is left unconfirmed without an argument", () => {
    const bare = REGISTRY.filter(
      (e) =>
        e.recovery === "permanent" &&
        e.confirm.length === 0 &&
        (e.unconfirmed?.length ?? 0) === 0,
    ).map((e) => e.file);
    expect(bare).toEqual([]);
  });
});
