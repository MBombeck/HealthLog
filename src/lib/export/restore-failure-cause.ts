/**
 * Why the database refused a restore transaction, as a cause an operator can
 * act on.
 *
 * Every refusal used to read the same way: "the database refused the restore
 * part-way, the server log names the error". A statement cancelled by the
 * timeout, a constraint the file broke, a disk that filled up and a
 * connection that dropped all look alike from the console, and each needs a
 * different next step (#1031). The cause is read from the SQLSTATE the driver
 * reports, or from Prisma's own code where the refusal is Prisma's, and never
 * from the message text, which can quote the rows involved.
 */

export type RestoreFailureCause =
  "timeout" | "lock" | "constraint" | "storage" | "connection" | "other";

export const RESTORE_FAILURE_CAUSES: readonly RestoreFailureCause[] = [
  "timeout",
  "lock",
  "constraint",
  "storage",
  "connection",
  "other",
];

export interface ClassifiedRestoreFailure {
  cause: RestoreFailureCause;
  /** The five-character SQLSTATE, or Prisma's `P…` code, when there is one. */
  code: string | null;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The SQLSTATE behind a Prisma error. The pg driver adapter carries it on
 * `meta.driverAdapterError.cause.originalCode`; an error thrown straight from
 * `pg` carries it on `code`.
 */
function sqlState(err: unknown): string | null {
  const cause = field(field(field(err, "meta"), "driverAdapterError"), "cause");
  // Prisma's own codes (`P1001`, `P2028`) have the same length as a SQLSTATE,
  // so a top-level `code` counts only when it is not one of them.
  const own = field(err, "code");
  for (const candidate of [
    field(cause, "originalCode"),
    field(cause, "code"),
    typeof own === "string" && isPrismaCode(own) ? undefined : own,
  ]) {
    if (typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isPrismaCode(code: string): boolean {
  return /^P[1-9]\d{3}$/.test(code);
}

/** Prisma's own error code (`P2028`, `P1017`, …), when it has one. */
function prismaCode(err: unknown): string | null {
  const code = field(err, "code");
  return typeof code === "string" && isPrismaCode(code) ? code : null;
}

export function classifyRestoreFailure(err: unknown): ClassifiedRestoreFailure {
  const state = sqlState(err);
  if (state) {
    // 57014 is a cancelled statement: the statement timeout, in a restore.
    if (state === "57014") return { cause: "timeout", code: state };
    // 25P03: the idle-in-transaction timeout ended the session.
    if (state === "25P03") return { cause: "timeout", code: state };
    // Lock not available, deadlock, serialization failure.
    if (state === "55P03" || state === "40P01" || state === "40001") {
      return { cause: "lock", code: state };
    }
    // Integrity constraints (23) and invalid data (22).
    if (state.startsWith("23") || state.startsWith("22")) {
      return { cause: "constraint", code: state };
    }
    // Insufficient resources (53: disk full, out of memory) and I/O errors.
    if (state.startsWith("53") || state === "58030") {
      return { cause: "storage", code: state };
    }
    // Connection exceptions (08) and a server shutting down (57P01-57P03).
    if (state.startsWith("08") || /^57P0[1-3]$/.test(state)) {
      return { cause: "connection", code: state };
    }
    return { cause: "other", code: state };
  }
  const prisma = prismaCode(err);
  // P2028: the interactive transaction ran past its own time limit.
  if (prisma === "P2028") return { cause: "timeout", code: prisma };
  if (prisma === "P2034") return { cause: "lock", code: prisma };
  if (prisma === "P1001" || prisma === "P1002" || prisma === "P1017") {
    return { cause: "connection", code: prisma };
  }
  // A session the server ended (the idle-in-transaction timeout, a restart)
  // reaches the client as a plain error with no code at all.
  const message = err instanceof Error ? err.message : "";
  if (/connection error|not queryable|Connection terminated/i.test(message)) {
    return { cause: "connection", code: prisma };
  }
  return { cause: "other", code: prisma };
}

/**
 * Whether a restore failed because a row it inserted carries a primary key
 * already taken. The restore deletes the receiving account's own rows first,
 * so the key belongs to a row of another account: for a copy put into a
 * chosen account, the same file restored into a different account before.
 */
export function isPrimaryKeyConflict(err: unknown): boolean {
  if (sqlState(err) !== "23505") return false;
  const cause = field(field(field(err, "meta"), "driverAdapterError"), "cause");
  const index = field(field(cause, "constraint"), "index");
  const name =
    typeof index === "string"
      ? index
      : /unique constraint "([^"]+)"/.exec(
          String(field(cause, "originalMessage") ?? field(err, "message")),
        )?.[1];
  return typeof name === "string" && name.endsWith("_pkey");
}

/** The sentence the job row and the audit trail carry for each cause. */
export const RESTORE_FAILURE_CAUSE_MESSAGES: Record<
  RestoreFailureCause,
  string
> = {
  timeout:
    "The restore ran longer than the database allowed and was rolled back. Nothing was changed.",
  lock: "The restore waited on rows another process was changing and was rolled back. Nothing was changed. Start it again.",
  constraint:
    "The database rejected a record in the backup and the restore was rolled back. Nothing was changed.",
  storage:
    "The database ran out of disk space or memory during the restore and rolled it back. Nothing was changed.",
  connection:
    "The connection to the database was lost during the restore, which rolled it back. Nothing was changed.",
  other:
    "The restore could not be written and was rolled back. Nothing was changed.",
};
