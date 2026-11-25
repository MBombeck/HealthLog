/**
 * Optimistic-concurrency guard for per-user read-modify-write endpoints.
 *
 * Extracted from the shipped `/api/dashboard/widgets` fix (issue #581,
 * v1.32.16): a Save carrying the token it was based on writes CONDITIONALLY
 * on the stored document still carrying that token, so a Save that already
 * committed can never be silently reverted by a later request that started
 * from an older snapshot. A stale base returns 409 and writes NOTHING. A
 * request that omits the token keeps the prior unconditional write, byte for
 * byte the pre-guard behaviour, so older web builds and the native client
 * are unaffected.
 *
 * The token is the DOCUMENT's revision, never the row's `updatedAt`. These
 * guards once compared `User.updatedAt`, which every write to the account
 * row moves (a registry choice, a profile save, a sync cursor), so a
 * save on one surface made every other surface's token stale, and where a GET
 * served its token from the server cache the following saves answered 409
 * for minutes. Each document now has its own `*RevisedAt` column that the
 * database moves whenever that document's value changes (migration 0554);
 * no code sets one, and a closed list of files names them
 * (`src/__tests__/document-revision-guard.test.ts`).
 *
 * The wire token is OPAQUE by contract (an ISO instant today): the client
 * only ever echoes a server-returned value as `baseUpdatedAt`, never parses
 * or synthesises one.
 *
 * Two consumer shapes:
 *   - `guardedUserDocumentUpdate` — a field-by-field `Prisma.UserUpdateInput`
 *     on one settings document of the `User` row, guarded on that
 *     document's revision.
 *   - `guardedRowUpdate` — the generic core it wraps, for any row with a
 *     token column of its own.
 *
 * The caller always builds the `data` object field-by-field (no mass
 * assignment); this helper never spreads a parsed request body.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

/** Result of pulling the `baseUpdatedAt` transport field off a request body. */
export type TakeBaseTokenResult =
  { base: Date | undefined; rest: unknown } | { invalid: true };

/**
 * Pull the optimistic-concurrency base token off a raw request body BEFORE
 * the domain Zod parse, so the token never has to be declared on (and can
 * never pollute) the domain schema — several of these schemas are `.strict()`
 * or derive a change list from `Object.keys(parsed.data)`.
 *
 *   - no `baseUpdatedAt` key            → `{ base: undefined, rest: body }` (legacy write)
 *   - `baseUpdatedAt` a valid ISO date  → `{ base: Date, rest: body-without-the-field }`
 *   - `baseUpdatedAt` present but junk  → `{ invalid: true }` (caller returns 422)
 *
 * A non-object body passes through untouched as a tokenless request; the
 * domain Zod parse then rejects it on its own terms.
 */
export function takeBaseToken(body: unknown): TakeBaseTokenResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { base: undefined, rest: body };
  }
  const record = body as Record<string, unknown>;
  if (!("baseUpdatedAt" in record)) {
    return { base: undefined, rest: body };
  }
  const { baseUpdatedAt, ...rest } = record;
  if (baseUpdatedAt === undefined) {
    // Present-but-undefined can't arrive over JSON; treat it as tokenless.
    return { base: undefined, rest };
  }
  if (typeof baseUpdatedAt !== "string") {
    return { invalid: true };
  }
  const base = new Date(baseUpdatedAt);
  if (Number.isNaN(base.getTime())) {
    return { invalid: true };
  }
  return { base, rest };
}

/**
 * The single 422 a malformed base token earns — same wording + errorCode
 * across every guarded endpoint (matches the shipped widgets route).
 */
export function invalidBaseTokenError(): Response {
  return apiError("Invalid base token", 422, {
    errorCode: "invalid_base_updated_at",
  });
}

/** Per-endpoint conflict identity (annotation name + wire errorCode + prose). */
export interface ConflictSpec {
  /** Wide-event action name, `<surface>.<noun>.conflict`. */
  action: string;
  /** `meta.errorCode` on the 409 envelope. */
  errorCode: string;
  /** Human prose for the 409 `error` string. */
  message: string;
}

/** Either a ready-to-return 409 `Response`, or the fresh token to echo. */
export type GuardedUpdateResult =
  { conflict: Response } | { updatedAt: string };

/**
 * Generic conditional-update-or-409 core.
 *
 *   - `base === undefined` → run the UNCONDITIONAL write (backward-compat
 *     arm; this must stay the plain write forever) and echo its token.
 *   - `base` present → run the CONDITIONAL write; a zero match means the
 *     row advanced since the client read it → annotate + return a 409
 *     with NO write; a match re-reads the fresh token to echo.
 */
export async function guardedRowUpdate(opts: {
  base: Date | undefined;
  run: {
    /** The prior unconditional write; returns the row's fresh `updatedAt`. */
    unconditional: () => Promise<{ updatedAt: Date }>;
    /** The conditional write (guarded on `base`); returns the matched count. */
    conditional: (base: Date) => Promise<number>;
    /** Re-read the row's `updatedAt` after a matched conditional write. */
    freshToken: () => Promise<Date | undefined>;
  };
  conflict: ConflictSpec;
}): Promise<GuardedUpdateResult> {
  const { base, run, conflict } = opts;

  if (base === undefined) {
    const updated = await run.unconditional();
    return { updatedAt: (updated.updatedAt ?? new Date()).toISOString() };
  }

  const count = await run.conditional(base);
  if (count === 0) {
    annotate({
      action: { name: conflict.action },
      meta: { base_updated_at: base.toISOString() },
    });
    return {
      conflict: apiError(conflict.message, 409, {
        errorCode: conflict.errorCode,
      }),
    };
  }

  const fresh = await run.freshToken();
  return { updatedAt: (fresh ?? new Date()).toISOString() };
}

/**
 * The settings documents on the `User` row that carry their own lock token,
 * each mapped to the revision column the database moves when it changes.
 * Keep in step with the trigger `users_bump_document_revisions` (0554).
 */
export const USER_DOCUMENT_REVISION = {
  dashboardWidgets: "dashboardWidgetsRevisedAt",
  insightsLayout: "insightsLayoutRevisedAt",
  medicationListLayout: "medicationListLayoutRevisedAt",
  moodTagLayout: "moodTagLayoutRevisedAt",
  modulePreferences: "modulePreferencesRevisedAt",
  notificationPrefs: "notificationPrefsRevisedAt",
  coachPrefs: "coachPrefsRevisedAt",
  healthScoreConfig: "healthScoreConfigRevisedAt",
} as const satisfies Record<string, keyof Prisma.UserSelect>;

export type UserDocument = keyof typeof USER_DOCUMENT_REVISION;

/** A `select` that reads one document's revision. */
export function userDocumentRevisionSelect(
  document: UserDocument,
): Prisma.UserSelect {
  return { [USER_DOCUMENT_REVISION[document]]: true };
}

/** The wire token of one document from a row read with its revision. */
export function userDocumentToken(
  row: object | null | undefined,
  document: UserDocument,
): string | undefined {
  if (!row) return undefined;
  const value = (row as Record<string, unknown>)[
    USER_DOCUMENT_REVISION[document]
  ];
  return value instanceof Date ? value.toISOString() : undefined;
}

/** Read one document's current token straight from the row. */
export async function readUserDocumentToken(
  userId: string,
  document: UserDocument,
): Promise<string | undefined> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: userDocumentRevisionSelect(document),
  });
  return userDocumentToken(row, document);
}

function revisionOf(
  row: object | null | undefined,
  document: UserDocument,
): Date | undefined {
  const value = row
    ? (row as Record<string, unknown>)[USER_DOCUMENT_REVISION[document]]
    : undefined;
  return value instanceof Date ? value : undefined;
}

/**
 * `guardedRowUpdate` on one settings document of the `User` row, guarded on
 * that document's revision. The `data` object is always built by the caller
 * and must write only that document's columns.
 *
 * A caller that merges a partial body into the stored document passes the
 * transaction it read the document in, under `withUserRowLock`: the tokenless
 * arm writes unconditionally, so a merge read outside the lock lets two
 * overlapping tokenless writes each drop the other's change.
 */
export function guardedUserDocumentUpdate(opts: {
  userId: string;
  document: UserDocument;
  base: Date | undefined;
  data: Prisma.UserUpdateInput;
  conflict: ConflictSpec;
  client?: Prisma.TransactionClient;
}): Promise<GuardedUpdateResult> {
  const { userId, document, base, data, conflict } = opts;
  const db = opts.client ?? prisma;
  const revision = USER_DOCUMENT_REVISION[document];
  const select = userDocumentRevisionSelect(document);
  return guardedRowUpdate({
    base,
    conflict,
    run: {
      unconditional: async () => {
        const updated = await db.user.update({
          where: { id: userId },
          data,
          select,
        });
        return { updatedAt: revisionOf(updated, document) ?? new Date() };
      },
      conditional: async (b) => {
        const res = await db.user.updateMany({
          where: { id: userId, [revision]: b },
          data,
        });
        return res.count;
      },
      freshToken: async () => {
        const fresh = await db.user.findUnique({
          where: { id: userId },
          select,
        });
        return revisionOf(fresh, document);
      },
    },
  });
}
