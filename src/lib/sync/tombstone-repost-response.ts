/**
 * The single create routes' answer to a re-post of an entry the person
 * deleted in HealthLog (`tombstone-repost.ts` has the rule).
 *
 * A bulk route refuses the entry inside its `200` (`status: "skipped"`,
 * `reason: "deleted_in_healthlog"`). A single route has one entry, so it
 * answers the request:
 *
 *     410 { data: null, error, meta: { errorCode, reason: "deleted_in_healthlog", id } }
 *
 * `410 Gone` because the entry the `externalId` names is gone for good from
 * this server's point of view: nothing was written, and sending it again
 * gets the same answer. A client treats it as final and drops the entry from
 * its outbox. `reason` is the same word the bulk routes use, `id` the deleted
 * row, `errorCode` the route's own (`<domain>.deleted_in_healthlog`).
 */
import { apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { DELETED_IN_HEALTHLOG_REASON } from "@/lib/sync/tombstone-repost";

export const DELETED_IN_HEALTHLOG_STATUS = 410;

/** The refusal's `errorCode`, per route. */
export const DELETED_IN_HEALTHLOG_ERROR_CODES = {
  mood: "mood.deleted_in_healthlog",
  measurement: "measurement.deleted_in_healthlog",
  cycleDayLog: "cycle.day-log.deleted_in_healthlog",
  auditC: "anamnesis.auditC.deleted_in_healthlog",
} as const;

export function deletedInHealthLogRefusal(
  route: keyof typeof DELETED_IN_HEALTHLOG_ERROR_CODES,
  id: string,
): Response {
  const errorCode = DELETED_IN_HEALTHLOG_ERROR_CODES[route];
  annotate({
    action: { name: "sync.repost.refused" },
    meta: { error_code: errorCode },
  });
  return apiError(
    "This entry was deleted in HealthLog",
    DELETED_IN_HEALTHLOG_STATUS,
    { errorCode, reason: DELETED_IN_HEALTHLOG_REASON, id },
  );
}
