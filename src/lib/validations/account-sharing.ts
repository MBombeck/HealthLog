/**
 * v1.36.0 — request shapes for the account-sharing lifecycle.
 *
 * Four verbs are exercised through these routes (invite, accept, end, switch)
 * and only two of them carry a body worth validating. What is NOT here is as
 * deliberate as what is:
 *
 *   * No `userId`, `grantorId` or `granteeId` on any body. Both sides of a
 *     grant come from the authenticated session and the row itself. A body
 *     field naming a party would be an authorization decision made by the
 *     caller.
 */
import { z } from "zod/v4";

import { SHARE_DOMAINS } from "@/lib/sharing/scope";

/**
 * How long a value naming an account may be.
 *
 * Matches the resolver's own selector bound (`MAX_SELECTOR_LENGTH`, 64): ids
 * are 25-character cuids, and a longer string names nothing that could exist.
 */
const MAX_ACCOUNT_ID_LENGTH = 64;

/**
 * An e-mail address or a username, whichever the owner knows the person by.
 *
 * The same identifier the login form accepts, matched the same way (either
 * column, case-insensitively), because asking somebody to invite a housemate
 * by a different name than the one that housemate types to sign in is a
 * support ticket waiting to happen.
 *
 * The 255 bound is the e-mail column's practical ceiling; anything past it is
 * refused before it reaches a query.
 */
export const inviteGrantSchema = z
  .object({
    identifier: z.string().trim().min(1).max(255),
    /**
     * Optional lapse date. Absent or null means the grant runs until somebody
     * ends it — the common household case, where an expiry the owner has to
     * remember to renew is worse than one that does not exist.
     */
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    /**
     * What the invitation offers, and the ONLY place the level is defaulted.
     *
     * `inviteGrant` takes the level as a required argument, so the domain module
     * never guesses; this line is the single answer to "what does an omitted
     * field mean", which keeps an older client's payload valid without a second
     * copy of the same decision further down. A grant carries one of the three
     * levels from the moment it is offered and stays that way: there is no
     * endpoint that widens a live grant, because widening it would carry one
     * consent and it would not be the delegate's. The way up is a new
     * invitation, accepted again.
     */
    access: z
      .enum(["READ", "WRITE", "MANAGE"])
      .default("READ")
      .describe(
        "READ can read the record and change nothing. WRITE can additionally ADD entries (readings, results, observations, a medication, a marked dose) and can still edit or delete nothing, including its own. MANAGE can additionally change and remove entries, including ones the owner wrote, and read the generated insights; it never reaches the identity surfaces (login, second factor, connections, tokens, settings, or who else has access). Omitted means READ, so a client that predates the field keeps working. The level is fixed when the invitation is written: no endpoint raises a live grant, because that would widen what the delegate accepted without asking them again. The way up is a new invitation the delegate accepts.",
      ),
    /**
     * v1.37.0 — which sections of the record the invitation opens.
     *
     * Absent or null is the entire record: the shape every invitation had
     * before this field existed, and the one an owner who does not narrow keeps
     * getting. A client that predates the field therefore mints exactly what it
     * used to mint, which is why this is optional where `access` is defaulted —
     * there is no third state to default to.
     *
     * `.min(1)` rather than a bare array, because an empty selection is not a
     * narrow grant, it is a grant that opens nothing: a row nobody could use,
     * written by somebody who thought they were sharing something. The enum is
     * the closed vocabulary itself, so an unknown key and the distinguished
     * `record` value (which is deliberately not a member) are both refused here
     * as a 422 naming the field, rather than reaching the domain module as an
     * opaque refusal.
     */
    scope: z
      .array(z.enum(SHARE_DOMAINS))
      .min(1)
      .nullable()
      .optional()
      .describe(
        "The sections of the record this invitation opens. Omitted or null means the entire record, which is what every grant written before v1.37.0 means and what an owner who does not narrow still gets. A non-null value is a non-empty array of section keys from the closed vocabulary; an empty array, an unknown key and the whole-record sentinel `record` are each refused. A stored scope never grows: a section added by a later release is not in a set an owner ticked before it existed.",
      ),
  })
  .refine((body) => !(body.access === "MANAGE" && body.scope != null), {
    // Whole-record by construction, and refused at the request shape as well as
    // in the domain module. "They can do anything, but only to part of you"
    // promises a boundary an edit cannot keep — a note in one section can concern
    // any other — so the product does not offer it and neither end accepts it.
    path: ["scope"],
    message: "Manage access always covers the entire record",
  });

export type InviteGrantBody = z.infer<typeof inviteGrantSchema>;

/**
 * The switch body. `null` is the whole point of the field rather than an
 * omission: clearing the switch and setting one are the same act pointed in
 * two directions, and a separate "unswitch" route would be a second place to
 * get the session write right.
 */
export const switchAccountSchema = z.object({
  accountId: z.string().min(1).max(MAX_ACCOUNT_ID_LENGTH).nullable(),
});

export type SwitchAccountBody = z.infer<typeof switchAccountSchema>;
