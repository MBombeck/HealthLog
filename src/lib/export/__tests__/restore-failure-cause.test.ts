/**
 * #1031 — a rolled-back restore names what the database refused it over.
 *
 * The error shapes below are the ones the Prisma client and the pg driver
 * adapter actually throw, captured from a real run: a model call and a raw
 * query cancelled by the statement timeout, an interactive transaction past
 * its own limit, a foreign-key violation, and the plain error a session the
 * server ended leaves behind.
 *
 * Mutation check: map `57014` to "other" in `classifyRestoreFailure` and the
 * two statement-timeout rows go red; drop the `P2028` branch and the expired
 * transaction row does.
 */
import { describe, expect, it } from "vitest";

import {
  classifyRestoreFailure,
  isPrimaryKeyConflict,
  RESTORE_FAILURE_CAUSE_MESSAGES,
  RESTORE_FAILURE_CAUSES,
} from "@/lib/export/restore-failure-cause";

function adapterError(prismaCode: string, sqlState: string, extra = {}) {
  return Object.assign(new Error(`Database error. Code: \`${sqlState}\``), {
    name: "PrismaClientKnownRequestError",
    code: prismaCode,
    meta: {
      modelName: "Measurement",
      driverAdapterError: {
        cause: {
          originalCode: sqlState,
          originalMessage: "value from the database",
          kind: "postgres",
          ...extra,
        },
      },
    },
  });
}

describe("classifyRestoreFailure", () => {
  it.each([
    [
      "deleteMany cancelled by the statement timeout",
      adapterError("P2039", "57014"),
      "timeout",
      "57014",
    ],
    [
      "raw query cancelled by the statement timeout",
      adapterError("P2010", "57014"),
      "timeout",
      "57014",
    ],
    [
      "session ended idle in a transaction",
      adapterError("P2010", "25P03"),
      "timeout",
      "25P03",
    ],
    ["lock not available", adapterError("P2010", "55P03"), "lock", "55P03"],
    ["deadlock", adapterError("P2010", "40P01"), "lock", "40P01"],
    [
      "foreign-key violation",
      adapterError("P2003", "23503", { kind: "ForeignKeyConstraintViolation" }),
      "constraint",
      "23503",
    ],
    ["unique violation", adapterError("P2002", "23505"), "constraint", "23505"],
    ["invalid value", adapterError("P2010", "22P02"), "constraint", "22P02"],
    ["disk full", adapterError("P2010", "53100"), "storage", "53100"],
    ["out of memory", adapterError("P2010", "53200"), "storage", "53200"],
    [
      "server shutting down",
      adapterError("P2010", "57P01"),
      "connection",
      "57P01",
    ],
    [
      "connection failure",
      adapterError("P2010", "08006"),
      "connection",
      "08006",
    ],
    ["some other SQLSTATE", adapterError("P2010", "XX000"), "other", "XX000"],
  ] as const)("%s", (_label, err, cause, code) => {
    expect(classifyRestoreFailure(err)).toEqual({ cause, code });
  });

  it("an interactive transaction past its own limit is a timeout", () => {
    const err = Object.assign(new Error("Transaction API error: expired"), {
      name: "PrismaClientKnownRequestError",
      code: "P2028",
      meta: { operation: "query", timeout: 498356, timeTaken: 505057 },
    });
    expect(classifyRestoreFailure(err)).toEqual({
      cause: "timeout",
      code: "P2028",
    });
  });

  it("a client whose session the server ended is a lost connection", () => {
    const err = new Error(
      "Client has encountered a connection error and is not queryable",
    );
    expect(classifyRestoreFailure(err)).toEqual({
      cause: "connection",
      code: null,
    });
  });

  it("an error straight from pg carries its SQLSTATE on `code`", () => {
    const err = Object.assign(new Error("canceling statement"), {
      code: "57014",
    });
    expect(classifyRestoreFailure(err).cause).toBe("timeout");
  });

  it("a PL/pgSQL raise is a SQLSTATE, not a Prisma code", () => {
    const err = Object.assign(new Error("raised"), { code: "P0001" });
    expect(classifyRestoreFailure(err)).toEqual({
      cause: "other",
      code: "P0001",
    });
  });

  it("anything else is other, with no code", () => {
    expect(classifyRestoreFailure(new Error("boom"))).toEqual({
      cause: "other",
      code: null,
    });
    expect(classifyRestoreFailure("boom")).toEqual({
      cause: "other",
      code: null,
    });
  });

  it("never reads the cause from the message, which can quote rows", () => {
    const err = new Error("canceling statement due to statement timeout");
    expect(classifyRestoreFailure(err).cause).toBe("other");
  });

  it("every cause has a sentence that says nothing was changed", () => {
    for (const cause of RESTORE_FAILURE_CAUSES) {
      expect(RESTORE_FAILURE_CAUSE_MESSAGES[cause]).toMatch(
        /Nothing was changed/,
      );
    }
  });
});

describe("isPrimaryKeyConflict", () => {
  it("names a duplicate primary key, as the driver reports it", () => {
    expect(
      isPrimaryKeyConflict(
        adapterError("P2010", "23505", {
          kind: "UniqueConstraintViolation",
          constraint: { index: "measurements_pkey" },
        }),
      ),
    ).toBe(true);
    // Without the structured name, read from the message.
    expect(
      isPrimaryKeyConflict(
        adapterError("P2010", "23505", {
          originalMessage:
            'duplicate key value violates unique constraint "mood_entries_pkey"',
        }),
      ),
    ).toBe(true);
  });

  it("does not name another unique rule, or another failure", () => {
    expect(
      isPrimaryKeyConflict(
        adapterError("P2002", "23505", {
          constraint: { index: "measurements_user_id_external_id_key" },
        }),
      ),
    ).toBe(false);
    expect(
      isPrimaryKeyConflict(
        adapterError("P2010", "23503", {
          constraint: { index: "measurements_pkey" },
        }),
      ),
    ).toBe(false);
    expect(isPrimaryKeyConflict(new Error("measurements_pkey"))).toBe(false);
  });
});
