"use client";

import { GrantInviteCard } from "@/components/settings/access/grant-invite-card";
import { HandoverDecisionCard } from "@/components/settings/access/handover-decision";
import { GrantsGivenCard } from "@/components/settings/access/grants-given-card";
import { GrantsReceivedCard } from "@/components/settings/access/grants-received-card";
import { ManagedProfileCard } from "@/components/settings/access/managed-profile-card";
import { RecordActivityCard } from "@/components/settings/access/record-activity-card";

/**
 * v1.36.0 — Settings → "Shared access".
 *
 * One section for one concept: who else can open this health record, and whose
 * this account may open. Split across two pages it would be two half-answers —
 * the settings IA rule this repository keeps rediscovering — so both directions
 * and the activity that follows from them live in one column, in the order
 * somebody reads them:
 *
 *   1. Invite — the act.
 *   2. Records you look after — the other act, and the one that CREATES a
 *      record rather than opening one that already exists.
 *   3. Who has access — the standing state, and the way to end it.
 *   4. What I can open — the same, from the other side.
 *   5. When it was opened — what actually happened.
 *
 * v1.37.0 put the managed-profile card second rather than in a settings area
 * of its own. A managed profile is a record with no login, reachable only
 * through the people who look after it — which is the same question this
 * section already answers twice, from a third side. Splitting it out would
 * have made "who may open which record" two half-answers on two pages, which
 * is the settings-IA rule below in miniature.
 *
 * Distinct from Settings → "Health record" → sharing links, which mints a
 * time-boxed read-only link to a REPORT for a clinician. This section is about
 * another ACCOUNT on this instance being able to open the live record, which is
 * a standing relationship rather than a document handed over once.
 *
 * Every card here reads and writes routes that refuse while the browser is
 * acting on somebody else's record, and the section is unreachable in that
 * state because the whole Settings entry drops out of the nav. Grant management
 * is the one surface a delegate must have no reach into at all: a delegate who
 * could invite, widen or transfer would be re-delegating access nobody granted
 * them.
 */
export function AccessSection() {
  return (
    <div className="space-y-4">
      {/* v1.42 (#959) — only for an account that claimed a managed profile
          and has not decided its former Guardians' access yet; it comes first
          because it is the one open question on this page. */}
      <HandoverDecisionCard />
      <GrantInviteCard />
      <ManagedProfileCard />
      <GrantsGivenCard />
      <GrantsReceivedCard />
      <RecordActivityCard />
    </div>
  );
}
