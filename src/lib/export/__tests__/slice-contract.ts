/**
 * One table row per backup slice, and the checks every row runs.
 *
 * A slice is the gate a restore passes each row of a file through. What it
 * owes the restore is the same for every slice: a well-formed row comes out
 * whole, a row missing a field the table needs is refused naming that field,
 * an empty identifier or label is refused, a value of the wrong kind is
 * refused, an absent defaulted field reads as its default, and a bounded
 * value is taken at its bound and refused one step past it.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";

export const AT = "2026-07-01T08:00:00.000Z";
export const SEALED = "QUJDRA==";

export interface SliceContract {
  schema: z.ZodType;
  /** A row as a current writer stores it, defaulted fields included. */
  valid: Record<string, unknown>;
  /** Fields the row cannot restore without. */
  required?: string[];
  /** Identifier and label fields that may not be the empty string. */
  nonEmpty?: string[];
  /** A value of the wrong kind per field. */
  wrongType?: Record<string, unknown>;
  /** What an absent field reads as. */
  defaults?: Record<string, unknown>;
  /** Values still taken, as `[field, value]`. */
  accepts?: Array<[string, unknown]>;
  /** Values refused, as `[field, value]`. */
  refuses?: Array<[string, unknown]>;
}

/** The first member of a Prisma enum object or a literal tuple. */
export function first<T>(values: Record<string, T> | readonly T[]): T {
  return (Array.isArray(values) ? values : Object.values(values))[0] as T;
}

/** The dotted paths of the issues a value raises; `[]` when it parses. */
export function issuePaths(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
}

function without(row: Record<string, unknown>, field: string) {
  const copy = { ...row };
  delete copy[field];
  return copy;
}

export function describeSlice(name: string, c: SliceContract): void {
  describe(name, () => {
    it("restores a well-formed row whole", () => {
      expect(c.schema.parse(c.valid)).toEqual(c.valid);
    });

    for (const field of c.required ?? []) {
      it(`refuses a row without ${field}`, () => {
        expect(issuePaths(c.schema, without(c.valid, field))).toContain(field);
      });
    }

    for (const field of c.nonEmpty ?? []) {
      it(`refuses an empty ${field}`, () => {
        expect(issuePaths(c.schema, { ...c.valid, [field]: "" })).toContain(
          field,
        );
      });
    }

    for (const [field, value] of Object.entries(c.wrongType ?? {})) {
      it(`refuses ${field} of the wrong kind`, () => {
        expect(issuePaths(c.schema, { ...c.valid, [field]: value })).toContain(
          field,
        );
      });
    }

    for (const [field, value] of Object.entries(c.defaults ?? {})) {
      it(`reads an absent ${field} as its default`, () => {
        const parsed = c.schema.parse(without(c.valid, field)) as Record<
          string,
          unknown
        >;
        expect(parsed[field]).toEqual(value);
      });
    }

    for (const [field, value] of c.accepts ?? []) {
      it(`takes ${field} = ${JSON.stringify(value)?.slice(0, 40)}`, () => {
        expect(issuePaths(c.schema, { ...c.valid, [field]: value })).toEqual(
          [],
        );
      });
    }

    for (const [field, value] of c.refuses ?? []) {
      it(`refuses ${field} = ${JSON.stringify(value)?.slice(0, 40)}`, () => {
        const paths = issuePaths(c.schema, { ...c.valid, [field]: value });
        expect(
          paths.some((p) => p === field || p.startsWith(`${field}.`)),
        ).toBe(true);
      });
    }
  });
}
