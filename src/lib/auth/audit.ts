import { settleWithin } from "@/lib/async/settle-within";
import { prisma } from "@/lib/db";
import { lookupIpGeo } from "@/lib/geo";
import { getEvent } from "@/lib/logging/context";

/**
 * v1.36.0 — the action a delegated request records against the record it read.
 *
 * One row per (owner, delegate, day), enforced by the partial unique index in
 * migration 0294. The name is part of the contract: the index is partial on
 * exactly this string, so changing it here without changing it there turns the
 * coalescing off and nothing fails.
 */
export const DELEGATED_ACCESS_ACTION = "sharing.record.accessed";

/**
 * Who is acting, when the row is not theirs.
 *
 * Read from the wide-event context rather than from an argument, because an
 * argument is something ~600 audit call sites can forget and this one cannot
 * be forgotten safely: a delegated action recorded with no actor is
 * indistinguishable from the owner having done it themselves.
 *
 * Returns null — "acted for themselves" — unless all three hold:
 *
 *   * the request resolved an acting account (`acting_as` is stamped, which
 *     only `requireRecordAuth` does and only after a live grant);
 *   * the actor is not that account (a switch into one's own record is not a
 *     delegation and has nothing to attribute);
 *   * the row is being filed under the account being ACTED ON. A delegable
 *     route that deliberately writes a row about the delegate — under the
 *     delegate's own id — is describing the delegate's own act, and stamping
 *     the actor there would say "somebody else did this to you" about a person
 *     acting on themselves.
 *
 * Every other path — every self-action, every refusal, every background job —
 * falls through to null, which is what every row written before this column
 * existed already means.
 */
function actingActorFor(filedUnder: string | null): string | null {
  const auth = getEvent()?.getAuth();
  const owner = auth?.acting_as ?? null;
  const actor = auth?.user_id ?? null;
  if (owner === null || actor === null) return null;
  if (owner === actor) return null;
  return filedUnder === owner ? actor : null;
}

export async function auditLog(
  action: string,
  opts: {
    userId?: string | null;
    /** Explicit worker attribution when no request context remains. */
    actorUserId?: string | null;
    /** Use the active transaction when the audit must commit atomically. */
    client?: Pick<typeof prisma, "auditLog">;
    details?: Record<string, unknown>;
    ipAddress?: string | null;
  } = {},
) {
  const userId = opts.userId ?? null;
  const client = opts.client ?? prisma;
  const entry = await client.auditLog.create({
    data: {
      action,
      userId,
      actorUserId:
        opts.actorUserId === undefined
          ? actingActorFor(userId)
          : opts.actorUserId,
      details: opts.details ? JSON.stringify(opts.details) : null,
      ipAddress: opts.ipAddress ?? null,
    },
  });

  // Fire-and-forget: resolve IP location + carrier and update the entry
  // with whichever fields the resolver could fill. v1.25.8 — `lookupIpGeo`
  // unifies the online location + carrier lookup with the offline ASN MMDB
  // (carrier now resolves from the online provider when the optional offline
  // DB is absent). The whole resolve still races a 3 s timeout so a hung
  // provider can't stall the audit write.
  if (opts.ipAddress && action.startsWith("auth.")) {
    const ipAddress = opts.ipAddress;
    settleWithin(lookupIpGeo(ipAddress), 3000, null)
      .then((result) => {
        if (!result) return;
        const { location, asn, carrier } = result;
        const data: {
          location?: string;
          asn?: number;
          carrier?: string | null;
        } = {};
        if (location) data.location = location;
        if (typeof asn === "number") data.asn = asn;
        if (carrier) data.carrier = carrier;
        if (Object.keys(data).length === 0) return;
        return prisma.auditLog.update({
          where: { id: entry.id },
          data,
        });
      })
      .catch(() => {
        // Silently ignore geo lookup failures
      });
  }
}

/**
 * v1.36.0 — record that a delegate opened an owner's record today.
 *
 * One row per (owner, delegate, day), with a counter inside it. The alternative
 * — a row per delegated request — would put a new hot stripe on the table this
 * schema already calls the highest-churn one, and would hand the owner an
 * activity view made of thousands of identical lines, which is a way of
 * answering nothing. "She was in my record on Tuesday, 40 times" is the answer
 * somebody actually wants.
 *
 * The coalescing is an INSERT that expects to lose. Two delegated reads racing
 * inside the same second both try to create the day's row and the unique index
 * sends the loser into the ON CONFLICT arm; a read-then-write would let both
 * decide the row was missing and leave a duplicate that the index would then
 * refuse anyway. `created_at` is written as an explicit UTC instant because
 * the column is TIMESTAMP WITHOUT TIME ZONE and a bare `NOW()` would be
 * converted through whatever timezone the connection happens to carry — the
 * day key in the index is a plain cast of this column, so a row landing an
 * hour off would land on the wrong day of the owner's trail.
 *
 * The action string appears twice in the statement below — once as the row's
 * value, once as a literal in the conflict predicate, because Postgres has to
 * prove the predicate matches the partial index and cannot do that through a
 * bind parameter. They must agree, and the integration test that asserts a
 * second read produces no second row is what fails when they stop agreeing.
 *
 * Fire-and-forget by the `ApiToken.lastUsedAt` posture: a delegated read must
 * not wait on its own bookkeeping, and bookkeeping that fails must not turn a
 * successful read into a 500. The promise is returned so a test can await it.
 */
export async function recordDelegatedAccess(
  ownerId: string,
  actorId: string,
): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO audit_logs (id, user_id, actor_user_id, action, details, created_at)
      VALUES (
        gen_random_uuid()::text,
        ${ownerId},
        ${actorId},
        ${DELEGATED_ACCESS_ACTION},
        '{"accesses":1}',
        (NOW() AT TIME ZONE 'UTC')
      )
      ON CONFLICT ("user_id", "actor_user_id", (("created_at")::date))
        WHERE "action" = 'sharing.record.accessed'
      DO UPDATE SET details = jsonb_set(
        COALESCE(audit_logs.details::jsonb, '{}'::jsonb),
        '{accesses}',
        to_jsonb(COALESCE((audit_logs.details::jsonb ->> 'accesses')::int, 0) + 1)
      )::text
    `;
  } catch {
    // Bookkeeping. The read it describes has already succeeded, and a failure
    // to describe it must not undo that.
  }
}
