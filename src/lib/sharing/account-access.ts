/**
 * v1.36.0 — what a caller may do with account sharing, resolved server-side.
 *
 * This module answers three questions for one caller, once per `/api/auth/me`:
 * which records may I open, which one am I inside right now, and what may I do
 * in it. Every answer is a VALUE, not an input to a client-side calculation.
 *
 * That is the whole design of this file and it is worth stating plainly,
 * because the tempting alternative is one line shorter: publish the grant rows
 * and let the client work out what they mean. Then two programs decide one
 * person's access — the resolver in `src/lib/api-handler.ts`, and whichever
 * client is being read today — and they answer differently the first time an
 * expiry, a revocation or a second access level appears. The client renders
 * `canSwitch` and `canWrite`; it never computes them, and there is nothing in
 * the payload it could compute them from.
 *
 * `canWrite` is resolved here through {@link grantAllows} against the real
 * row rather than stored or hardcoded, which is why the level becoming an
 * invitation choice needed no edit to this file: an accepted WRITE grant
 * started answering true the moment one could exist, and an accepted MANAGE
 * grant did the same one release later. It answers "may add to this record"
 * and nothing beyond that; what a MANAGE grant additionally admits is carried
 * by `level`, which is a value the client renders and never a flag it reasons
 * from.
 *
 * v1.37.0 adds `sections` on the same terms. It is the stored scope run
 * through the one resolver (`resolveGrantSections`), not the column: a client
 * never sees a blob it would have to interpret, and the fail-closed reading of
 * an unparseable one reaches the payload as the empty list rather than as
 * silence.
 *
 * What is deliberately NOT published: the other account's avatar. The avatar
 * bytes are owner-scoped (`/api/user/avatar/{id}` refuses any id but the
 * caller's own), so a URL here would resolve to a 403 and paint a broken
 * image. Opening that route to a delegate is a classification decision about
 * a route, not a decision the account payload gets to make on the side.
 * Clients paint the initials fallback they already have.
 */
import { prisma } from "@/lib/db";
import type {
  AccountAccess,
  AccountAccessEntry,
  AccountAccessLevel,
} from "@/lib/sharing/account-access-view";
import { resolveGrantSections } from "@/lib/sharing/grant-view";
import { grantAllows, isGrantActive } from "@/lib/sharing/grants";
import type { AccountGrantAccess } from "@/generated/prisma/client";

/**
 * The stored level, as the contract names it.
 *
 * A total map rather than a chain of ternaries, and the difference is the
 * failure it removes: the shipped expression was
 * `access === "WRITE" ? "write" : "read"`, which answered "read" for anything
 * it did not recognise. When a third level arrived that would have published
 * a MANAGE grant as read-only — the payload understating access is the
 * direction that reads as safe and is not, because the client renders what it
 * is told and the server would have gone on admitting the writes. An unlisted
 * enum member does not typecheck here, so the next level cannot ship silent.
 */
const LEVEL: Record<AccountGrantAccess, AccountAccessLevel> = {
  READ: "read",
  WRITE: "write",
  MANAGE: "manage",
};

/**
 * Resolve the sharing block for one caller.
 *
 * The block is always present, even for an account with no grants in either
 * direction: an empty `accounts` array with `canSwitch: false` says "nobody has
 * shared anything with you", which is a different statement from a missing
 * field (which says "this server does not know about sharing"). Absence reads
 * as absence.
 *
 * Takes the whole auth context rather than a pair of ids, so the carrier column
 * is named here and in no route file — the boundary guard in
 * `src/__tests__/acting-account-boundary-guard.test.ts` keeps that list short
 * on purpose, and a field plucked out at every call site is how such a list
 * grows one entry per surface.
 *
 * The session's stamp is deliberately NOT trusted to mean access: an entry
 * appears in `active` only if the same pass that
 * built `accounts` admitted it. So a stamp left behind by a grant that lapsed
 * between two requests reads as "not switched" here, which is exactly what the
 * request resolver will independently decide about the next delegated read.
 * The client's job on seeing that mismatch is to clear the stamp, not to
 * reason about it.
 */
export async function resolveAccountAccess(auth: {
  user: { id: string };
  session: { actingAsUserId?: string | null };
}): Promise<AccountAccess> {
  const actorId = auth.user.id;
  const stamped = auth.session.actingAsUserId ?? null;
  const now = new Date();

  // Narrow in SQL on the one condition the partial unique index makes cheap,
  // and let the state machine decide the rest — the same split
  // `findActiveGrant` uses, and for the same reason: a SQL predicate spelling
  // out "accepted and not expired" beside a TypeScript one is two places
  // deciding one question.
  const rows = await prisma.accountGrant.findMany({
    where: { granteeId: actorId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    include: {
      grantor: { select: { id: true, username: true, displayName: true } },
    },
  });

  const accounts: AccountAccessEntry[] = rows
    .filter((grant) => isGrantActive(grant, now))
    .map((grant) => {
      // One expression, two names. `access` is what v1.36.0 published and
      // what shipped clients read; `level` is what the three-level contract
      // calls it. Deriving both from one lookup is what stops them saying
      // different things about the same row.
      const level = LEVEL[grant.access];
      return {
        accountId: grant.grantor.id,
        username: grant.grantor.username,
        displayName: grant.grantor.displayName,
        access: level,
        level,
        sections: resolveGrantSections(grant.scopeJson),
        canWrite: grantAllows(grant, "write", now),
      };
    });

  const active =
    stamped === null
      ? null
      : (accounts.find((a) => a.accountId === stamped) ?? null);

  return { accounts, active, canSwitch: accounts.length > 0 };
}
