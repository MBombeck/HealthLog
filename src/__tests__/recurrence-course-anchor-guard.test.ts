/**
 * v1.40 (#1024) — the course rule for a rolling anchor is opt-in.
 *
 * An intake whose next rolling dose falls before `startsOn` belongs to an
 * earlier medication course and must not anchor the current one. That rule
 * is only right where `startsOn` IS a course start. A measurement or booster
 * reminder passes its anchor date in the same field, and the rule once made a
 * booster fourteen years overdue come due "later today". So the rule applies
 * only when the context declares `rollingAnchor: "courseStart"`.
 *
 * This guard enumerates every place in `src` that builds a
 * `RecurrenceContext` literal and holds two lists against it: every
 * medication builder declares the course start, every other builder does
 * not. A new builder lands in neither list and fails until someone decides
 * which it is. The scan asserts a floor on what it found, so a matcher that
 * stopped matching fails instead of agreeing with an empty tree.
 *
 * #1280 — the same list carries the instant "End course" ended a course:
 * every medication builder threads `endedAt` into the context, or the
 * engine would keep a dose due after the course was ended. A builder passes
 * when its block names `endedAt` or spreads a window that carries it
 * (`...window` from `mintWindow`, `...medicationWindow(row)`).
 *
 * The compliance side builds its context in two more shapes,
 * `ComplianceMedicationContext` and the `CadenceEngineContext` the timelines
 * hand the engine, and both dropped `endedAt` once: the streak and the
 * per-window timeline copied the context field by field and counted the dose
 * after an ended course as missed. Both types now require the field, and the
 * last leg holds every builder of either to naming it, and the timelines to
 * the one builder.
 *
 * Limit, stated: a literal passed straight to the engine without the
 * `RecurrenceContext` annotation is invisible here. Every medication path
 * today goes through one of the annotated builders below.
 */
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { readSource, readSourceText } from "./helpers/source-files";

const SRC = resolve(__dirname, "..");
const ROOT = resolve(SRC, "..");

/** Medication builders: `startsOn` is a course start. */
const MEDICATION_BUILDERS = [
  "src/lib/analytics/compliance/adapters.ts",
  "src/lib/medications/scheduling/cadence.ts",
  "src/lib/medications/scheduling/worker-helpers.ts",
];

/** Builders whose `startsOn` is an anchor date, never a course start. */
const NON_MEDICATION_BUILDERS = ["src/lib/measurement-reminders/scheduling.ts"];

const DECLARATION =
  /(\)\s*:\s*RecurrenceContext\s*\{|:\s*RecurrenceContext\s*=\s*\{)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "generated" || entry.name === "__tests__"
        ? []
        : sourceFiles(full);
    }
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** The body of the object literal (or function body) opened at `open`. */
function blockAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

interface Builder {
  file: string;
  declaresCourseStart: boolean;
  threadsEndedAt: boolean;
}

const THREADS_ENDED_AT = /\bendedAt\b|\.\.\.\s*(window\b|medicationWindow\()/;

function builders(): Builder[] {
  const out: Builder[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readSourceText(file);
    for (const m of text.matchAll(DECLARATION)) {
      const open = m.index! + m[0].length - 1;
      const block = blockAt(text, open);
      out.push({
        file: relative(ROOT, file),
        declaresCourseStart: /rollingAnchor\s*:\s*"courseStart"/.test(block),
        threadsEndedAt: THREADS_ENDED_AT.test(block),
      });
    }
  }
  return out;
}

describe("the rolling course anchor is opt-in", () => {
  it("finds the builders it judges (no vacuous pass)", () => {
    const found = builders();
    expect(found.length).toBeGreaterThanOrEqual(5);
    // The matcher sees an annotated literal and a typed return.
    expect([
      ...`const c: RecurrenceContext = { a: 1 };\nfunction f(): RecurrenceContext {\n return {};\n}`.matchAll(
        DECLARATION,
      ),
    ]).toHaveLength(2);
  });

  it("puts every builder on exactly one of the two lists", () => {
    const files = [...new Set(builders().map((b) => b.file))].sort();
    expect(files).toEqual(
      [...MEDICATION_BUILDERS, ...NON_MEDICATION_BUILDERS].sort(),
    );
  });

  it("has every medication builder declare the course start", () => {
    const missing = builders().filter(
      (b) => MEDICATION_BUILDERS.includes(b.file) && !b.declaresCourseStart,
    );
    expect(missing).toEqual([]);
  });

  it("has every medication builder thread the instant a course was ended", () => {
    const medication = builders().filter((b) =>
      MEDICATION_BUILDERS.includes(b.file),
    );
    expect(medication.length).toBeGreaterThanOrEqual(3);
    expect(medication.filter((b) => !b.threadsEndedAt)).toEqual([]);
    // The matcher, held against what it must and must not accept.
    expect(THREADS_ENDED_AT.test("endedAt: row.endedAt,")).toBe(true);
    expect(THREADS_ENDED_AT.test("...medicationWindow(row),")).toBe(true);
    expect(THREADS_ENDED_AT.test("endsOn: row.endsOn,")).toBe(false);
  });

  it("keeps every other builder on the default (the last intake anchors)", () => {
    const declaring = builders().filter(
      (b) => NON_MEDICATION_BUILDERS.includes(b.file) && b.declaresCourseStart,
    );
    expect(declaring).toEqual([]);
  });
});

/** A typed literal or a typed return of either compliance context. */
const COMPLIANCE_CONTEXT_DECLARATION =
  /(\)\s*:\s*(?:CadenceEngineContext|ComplianceMedicationContext)\s*\{|:\s*(?:CadenceEngineContext|ComplianceMedicationContext)(?:\s*\|\s*undefined)?\s*=\s*[^;{]*\{)/g;

function complianceContextBuilders(): Array<{ file: string; block: string }> {
  const out: Array<{ file: string; block: string }> = [];
  for (const file of sourceFiles(SRC)) {
    const text = readSourceText(file);
    for (const m of text.matchAll(COMPLIANCE_CONTEXT_DECLARATION)) {
      const open = m.index! + m[0].length - 1;
      out.push({ file: relative(ROOT, file), block: blockAt(text, open) });
    }
  }
  return out;
}

describe("the compliance contexts carry the instant a course was ended", () => {
  it("builds the engine's context in one place, which names endedAt", () => {
    const found = complianceContextBuilders();
    // The two builders: the medication context and the engine's view of it.
    expect(found.map((b) => b.file).sort()).toEqual([
      "src/lib/analytics/compliance/display.ts",
      "src/lib/analytics/compliance/types.ts",
    ]);
    for (const b of found) {
      expect(b.block, b.file).toMatch(/\bendedAt\s*:/);
    }
    // The matcher sees each shape the timelines used to write.
    const shapes = [
      "const e: CadenceEngineContext = { a: 1 };",
      "const e: CadenceEngineContext | undefined = ctx ? { a: 1 } : undefined;",
      "function f(): ComplianceMedicationContext {\n return {};\n}",
    ];
    for (const shape of shapes) {
      expect([...shape.matchAll(COMPLIANCE_CONTEXT_DECLARATION)]).toHaveLength(
        1,
      );
    }
  });

  it("has both timelines take the engine context from that builder", () => {
    const display = readSource("src/lib/analytics/compliance/display.ts", [
      "function cadenceEngineContextOf(",
      "function buildTimelineForWindow(",
    ]);
    const uses = display.match(/cadenceEngineContextOf\(ctx\)/g) ?? [];
    expect(uses.length).toBe(2);
  });
});
