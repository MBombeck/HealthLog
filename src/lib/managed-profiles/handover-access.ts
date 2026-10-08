/**
 * v1.42 (#959) — what happens to each Guardian's access when a managed profile
 * is handed over. Every rule about that choice lives in this file, and only
 * here, so that changing the policy is one edit:
 *
 *   - the three levels a Guardian can end up with;
 *   - the level a Guardian is proposed when nobody says otherwise;
 *   - which levels the issuing Guardian may propose, and which the new owner
 *     may then pick;
 *   - what each level means as an `AccountGrant` row.
 *
 * The flow it serves (option C): the Guardian who mints the link proposes a
 * level per Guardian. Claiming applies the proposals at once, so the record is
 * never left without a decision. The new owner then sees each Guardian's access
 * and decides finally; until they do, the proposed level is what holds.
 *
 * No Prisma and no server imports: the settings dialog, the claim page and the
 * decision screen read the same constants the server enforces.
 */

/** `end` removes the Guardian; `read` leaves view-only; `manage` keeps all. */
export const HANDOVER_ACCESS_LEVELS = ["end", "read", "manage"] as const;

export type HandoverAccess = (typeof HANDOVER_ACCESS_LEVELS)[number];

/**
 * The proposal a Guardian gets when the issuing Guardian named none for them,
 * including somebody who became a Guardian after the link was minted.
 *
 * View-only rather than either extreme: it keeps the people who looked after
 * the record able to see it (continuity of care), and it takes away every
 * act on it, so nothing is done in the new owner's name until they decide.
 */
export const DEFAULT_HANDOVER_ACCESS: HandoverAccess = "read";

/** The levels the issuing Guardian may propose. */
export const PROPOSABLE_HANDOVER_ACCESS: readonly HandoverAccess[] = [
  ...HANDOVER_ACCESS_LEVELS,
];

/**
 * The levels the new owner may choose for a Guardian on the decision screen.
 *
 * Every level, independent of the proposal: a proposal can never bind the
 * person whose record it is. Raising a Guardian back to `manage` re-creates
 * access that Guardian already held and accepted, so it needs no new
 * acceptance from them — and it can only reach the level they held, because
 * every Guardian held `manage`.
 */
export const OWNER_CHOOSABLE_HANDOVER_ACCESS: readonly HandoverAccess[] = [
  ...HANDOVER_ACCESS_LEVELS,
];

/** The grant level a handover access maps to, or null for `end`. */
export function grantAccessFor(
  access: HandoverAccess,
): "READ" | "MANAGE" | null {
  switch (access) {
    case "end":
      return null;
    case "read":
      return "READ";
    case "manage":
      return "MANAGE";
  }
}

/**
 * The handover level a live grant reads as.
 *
 * WRITE cannot arise from a handover, but a grant the owner re-shaped through
 * the ordinary sharing panel can be anything; it reads as `read` here because
 * this vocabulary has nothing between view and manage, and the decision screen
 * shows such a row as already settled rather than offering to change it.
 */
export function handoverAccessOf(
  grant: { access: "READ" | "WRITE" | "MANAGE" } | null,
): HandoverAccess {
  if (grant === null) return "end";
  return grant.access === "MANAGE" ? "manage" : "read";
}

/** The age below which the Guardian dialog shows the minor hint. */
export const HANDOVER_MINOR_AGE = 16;

/**
 * Whether a date of birth (`yyyy-MM-dd`) is under {@link HANDOVER_MINOR_AGE}
 * on `today`. A hint only: there is no age gate, because the age of majority
 * differs between countries and the Guardian knows the person.
 */
export function isHandoverMinor(
  dateOfBirth: string | null,
  today: Date = new Date(),
): boolean {
  if (!dateOfBirth) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!match) return false;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  let age = today.getUTCFullYear() - year;
  const beforeBirthday =
    today.getUTCMonth() + 1 < month ||
    (today.getUTCMonth() + 1 === month && today.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  return age < HANDOVER_MINOR_AGE;
}
