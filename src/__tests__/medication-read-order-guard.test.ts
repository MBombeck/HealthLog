/**
 * Every medication and intake read orders its ties.
 *
 * Postgres returns rows that tie on an `ORDER BY` in no particular order, and
 * not the same one twice. The medication reads ordered by columns two rows
 * share all the time: a schedule list with no order at all, medications by
 * `createdAt` (one import writes many in a millisecond), intakes by
 * `scheduledFor` (a twice-daily medication puts every morning dose on the same
 * instant), "the latest intake" by `takenAt`. A client then read the same
 * account in a different order from one request to the next, and a "latest"
 * lookup picked either of two rows. The parity suite saw it as `<id:N>`
 * labels swapping under a loaded run.
 *
 * So every `findMany` / `findFirst` on a medication table, its nested
 * includes too, states an order that ends on a unique key, and a medication's
 * schedules are never included unordered (`MEDICATION_SCHEDULE_ORDER`). An
 * order held in a variable is checked where it is built, and listed below.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(__dirname, "..");

const READ =
  /\b(?:prisma|tx|db|client)\s*\.\s*(medication|medicationSchedule|medicationIntakeEvent|medicationScheduleRevision|medicationPauseEra|medicationCourse|medicationDoseChange|medicationInventoryItem|medicationInventoryEvent|medicationSideEffect|medicationIngredient|medicationCategoryAssignment)\s*\.\s*(findMany|findFirst|findFirstOrThrow)\s*\(/g;

/** Unique keys an order may end on, beyond `id`. */
const UNIQUE_LAST_KEYS: Record<string, string> = {
  medicationCategoryAssignment: "medicationId",
};

/** Orders built in a variable, by file, with where the tie-breaker lives. */
const ORDER_VARIABLES: Record<string, string> = {
  "lib/medications/list-intake-events.ts":
    "`orderBy` ends on `{ id: sortDir }` in both arms, built just above the read.",
};

function closing(text: string, at: number, open: string, close: string) {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}

interface Read {
  where: string;
  model: string;
  orders: string[];
  variableOrder: boolean;
  unorderedSchedules: boolean;
}

function reads(): Read[] {
  const out: Read[] = [];
  const files = walkSourceFiles(SRC, { floor: 2000 }).filter(
    (rel) => !rel.startsWith("generated/") && !rel.includes("__tests__"),
  );
  for (const rel of files) {
    const text = stripComments(readSourceText(join(SRC, rel)), rel);
    for (const match of text.matchAll(READ)) {
      const open = match.index! + match[0].length - 1;
      const end = closing(text, open, "(", ")");
      const call = text.slice(open, end + 1);
      const orders: string[] = [];
      for (const order of call.matchAll(/orderBy\s*:\s*([[{])/g)) {
        const start = order.index! + order[0].length - 1;
        const bracket = order[1]!;
        const stop = closing(call, start, bracket, bracket === "[" ? "]" : "}");
        orders.push(call.slice(start, stop + 1).replace(/\s+/g, " "));
      }
      out.push({
        where: `${rel}:${text.slice(0, match.index).split("\n").length}`,
        model: match[1]!,
        orders,
        variableOrder: /\borderBy\s*(?:,|\})/.test(call),
        unorderedSchedules: /\bschedules\s*:\s*true\b/.test(call),
      });
    }
  }
  return out;
}

const ALL = reads();

/** Whether an order's last key is unique for the read's model. */
function endsUnique(order: string, model: string): boolean {
  const keys = [...order.matchAll(/(\w+)\s*:\s*(?:"(?:asc|desc)"|\{|\w)/g)]
    .map((m) => m[1]!)
    .filter((key) => key !== "sort" && key !== "nulls");
  const last = keys.at(-1);
  return last === "id" || last === UNIQUE_LAST_KEYS[model];
}

describe("medication reads order their ties", () => {
  it("finds the reads it is about", () => {
    requireFloor("medication reads", ALL, 150);
    requireFloor(
      "ordered medication reads",
      ALL.filter((read) => read.orders.length > 0),
      60,
    );
  });

  it("ends every stated order on a unique key", () => {
    const loose = ALL.flatMap((read) =>
      read.orders
        .filter((order) => !endsUnique(order, read.model))
        .map((order) => `${read.where} ${read.model}: ${order}`),
    );
    expect(loose).toEqual([]);
  });

  it("never includes a medication's schedules unordered", () => {
    expect(
      ALL.filter((read) => read.unorderedSchedules).map((read) => read.where),
    ).toEqual([]);
  });

  it("names every order held in a variable, and nothing else", () => {
    const files = [
      ...new Set(
        ALL.filter((read) => read.variableOrder).map(
          (read) => read.where.split(":")[0]!,
        ),
      ),
    ].sort();
    expect(files).toEqual(Object.keys(ORDER_VARIABLES).sort());
  });
});
