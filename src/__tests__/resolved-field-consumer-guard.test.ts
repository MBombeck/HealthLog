/**
 * Server-resolved fields are read, never rebuilt from their ingredients.
 *
 * Some answers depend on more than the browser can see: the record on screen
 * (which may be a managed or shared one, not the signed-in account), the
 * person's own targets, the operator's switches, the user's clock. The server
 * resolves each of them once and publishes the result; a client that rebuilds
 * one from the parts it happens to hold gets a plausible answer that is wrong
 * in exactly the cases nobody tests. Three of those shipped at once:
 *
 *   - the blood-pressure chart drew its target zones from `getBpTargets()` on
 *     the signed-in account's date of birth, losing the user's own band and,
 *     inside a managed record, using the viewer's age;
 *   - the intake pickers preselected on `active`, so an ended course could be
 *     the default dose;
 *   - Settings → Coach gated its tuning on the account's raw `disableCoach`,
 *     which answers for the viewer, not for the record.
 *
 * Each entry below names one resolved field and the ingredient patterns that
 * rebuild it. A match in client code (`src/components`, `src/hooks`, and every
 * `"use client"` module under `src/app` outside the API) fails, unless the
 * exact file is allowlisted with the reason it is not a re-derivation — the
 * switch that edits a stored value has to read that value.
 *
 * The guard cannot pass by reading nothing: the walk carries a floor, every
 * allowlisted file must still match (a stale entry fails), every rule's
 * pattern is checked against a sample of the shape it exists to catch, and
 * the total match count across the tree must be non-zero.
 *
 * Its honest limit: the matchers are line-shaped. A re-derivation spread over
 * several statements (an `active` check on one line, the `trackIntake` check
 * on the next) is not seen. The rules catch the shapes that shipped; review
 * catches the rest.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const ROOT = process.cwd();

interface ResolvedFieldRule {
  /** The server-resolved field clients must read. */
  field: string;
  /** Where the resolved value comes from. */
  servedBy: string;
  /** Ingredient shapes that rebuild the field in the browser. */
  patterns: RegExp[];
  /** A line each pattern must match, proving the matcher is live. */
  samples: string[];
  /**
   * A line that reads the resolved field as well is not a rebuild of it; the
   * rule skips lines matching this.
   */
  unlessLine?: RegExp;
  /** Files (relative to the repo root) allowed to match, and why. */
  allow: Record<string, string>;
  /**
   * When set, the rule reads exactly these files instead of the client tree:
   * for a pattern too common to ban everywhere (`.active`) that is a rebuild
   * only where a dose is being offered. Each file must exist.
   */
  scope?: string[];
}

const RULES: ResolvedFieldRule[] = [
  {
    field: "blood-pressure target band",
    servedBy:
      "`/api/insights/targets` (BLOOD_PRESSURE range + bpDiastolic.range), resolved for the record on screen with the user's own band first",
    patterns: [
      /\bgetBpTargets\s*\(/,
      /\bgetBpTargetsByAge\s*\(/,
      /\bresolveEffectiveBpTargets\s*\(/,
      /\bresolveBpTargetOverride\s*\(/,
    ],
    samples: [
      "const t = getBpTargets(new Date(user.dateOfBirth));",
      "getBpTargetsByAge(age, sex)",
      "resolveEffectiveBpTargets(profile, thresholds)",
      "resolveBpTargetOverride(profile, thresholds)",
    ],
    allow: {},
  },
  {
    field: "intakeActionable / courseStatus",
    servedBy:
      "the medication list and detail reads (`src/lib/medications/intake-actionable.ts`)",
    patterns: [
      // Offering a dose from `active` and `trackIntake` alone.
      /\bactive\b[^;\n]*\btrackIntake\b/,
      /\btrackIntake\b[^;\n]*\bactive\b/,
      // Course state from the end date against the clock.
      /\b(endsOn|endDate)\b[^;\n]*(<=?|>=?)[^;\n]*\b(now|today|Date\.now\(\)|new Date\(\))/,
      /\b(now|today|Date\.now\(\)|new Date\(\))[^;\n]*(<=?|>=?)[^;\n]*\b(endsOn|endDate)\b/,
      // The server's own resolvers, imported into the browser.
      /\bcourseStatusAt\s*\(/,
      /\bresolveIntakeActionability\s*\(/,
    ],
    samples: [
      "const canTake = med.active && med.trackIntake !== false;",
      "if (m.trackIntake && m.active) offer();",
      "const ended = med.endsOn != null && new Date(med.endsOn) < new Date();",
      "const ended = today > endsOn;",
      "courseStatusAt(med, now, tz)",
      "resolveIntakeActionability(med, now, tz)",
    ],
    unlessLine: /\bintakeActionable\b|\bcourseStatus\b/,
    allow: {},
  },
  {
    field: "intakeActionable in the dose pickers' default",
    servedBy:
      "`intakeActionable` on the medication list read (`pickDefaultMedicationId`)",
    // Listing active medications is fine anywhere (the dialog still lists
    // ended courses for back-filling). Choosing the dose to OFFER from
    // `active` is the rebuild, and these are the files that choose it.
    scope: [
      "src/lib/medications/default-medication.ts",
      "src/components/medications/log-intake-dialog.tsx",
      "src/components/dashboard/medication-intake-quick-add.tsx",
    ],
    patterns: [/\.active\b/],
    samples: ["const actives = options.filter((m) => m.active);"],
    unlessLine: /\bintakeActionable\b/,
    allow: {},
  },
  {
    field: "ai capability (coach and the rest)",
    servedBy:
      "`ai.capabilities` on `/api/auth/me`, read through `useAiCapability`",
    patterns: [
      /\.disableCoach\b/,
      /\bflags\??\.coach\b/,
      /from\s+["']@\/lib\/ai\/capabilities\/(resolve|load|gate|egress)["']/,
    ],
    samples: [
      "const coachEnabled = !user?.disableCoach;",
      "if (flags?.coach && x) show();",
      'import { resolveAiCapability } from "@/lib/ai/capabilities/resolve";',
    ],
    allow: {
      "src/components/settings/ai/disable-coach-card.tsx":
        "the Activate-Coach switch: it edits the stored opt-out, so its checked state is that value",
      "src/hooks/use-module-toggle.ts":
        "the module switch for the Coach (Settings hub and command palette): its checked state is the stored opt-out it writes",
      "src/components/settings/managed-record-settings-section.tsx":
        "the managed record's own settings form: the field's default is the record's stored opt-out",
      "src/hooks/use-auth.ts":
        "the `/me` payload normaliser: coerces the field against a stale payload, decides nothing",
    },
  },
  {
    field: "module surfaces",
    servedBy:
      "`modules` on `/api/auth/me` (record-scoped, grant-masked), read through `isSurfaceVisible` / `useNavModules`",
    patterns: [
      /\bisModuleEnabled\s*\(/,
      /\bresolveModuleMap\s*\(/,
      /\bmoduleAvailability\b/,
    ],
    samples: [
      "if (await isModuleEnabled(userId, 'cycle')) {}",
      "const modules = await resolveModuleMap(user.id);",
      "const off = user.moduleAvailability?.cycle === false;",
    ],
    allow: {
      "src/components/settings/modules-section.tsx":
        "the Modules hub: it shows the operator-off state of each toggle row, which is what `moduleAvailability` is published for",
      "src/components/command-palette/use-palette-index.ts":
        "the command palette's module switches: like the Modules hub it leaves out a switch the operator turned off, which is what `moduleAvailability` is published for",
      "src/hooks/use-auth.ts":
        "the `/me` payload normaliser: types and coerces the field, decides nothing",
    },
  },
];

function isClientModule(rel: string, source: string): boolean {
  if (rel.startsWith("src/components/") || rel.startsWith("src/hooks/")) {
    return true;
  }
  return /^\s*["']use client["']/.test(stripComments(source).trimStart());
}

function clientFiles(): Array<{ rel: string; code: string }> {
  const roots: Array<{ dir: string; floor: number }> = [
    { dir: "src/components", floor: 900 },
    { dir: "src/hooks", floor: 50 },
    { dir: "src/app", floor: 900 },
  ];
  const out: Array<{ rel: string; code: string }> = [];
  for (const { dir, floor } of roots) {
    for (const file of walkSourceFiles(join(ROOT, dir), { floor })) {
      const rel = `${dir}/${file}`;
      if (rel.startsWith("src/app/api/")) continue;
      if (rel.includes("/__tests__/") || /\.test\.tsx?$/.test(rel)) continue;
      const source = readFileSync(join(ROOT, rel), "utf8");
      if (!isClientModule(rel, source)) continue;
      out.push({ rel, code: stripComments(source) });
    }
  }
  return out;
}

const FILES = clientFiles();

function scopedFiles(scope: string[]): Array<{ rel: string; code: string }> {
  return scope.map((rel) => ({
    rel,
    code: stripComments(readFileSync(join(ROOT, rel), "utf8")),
  }));
}

function matchesFor(rule: ResolvedFieldRule): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const { rel, code } of rule.scope ? scopedFiles(rule.scope) : FILES) {
    code.split("\n").forEach((line, index) => {
      if (rule.unlessLine?.test(line)) return;
      if (!rule.patterns.some((pattern) => pattern.test(line))) return;
      const list = hits.get(rel) ?? [];
      list.push(`${rel}:${index + 1}: ${line.trim()}`);
      hits.set(rel, list);
    });
  }
  return hits;
}

describe("resolved-field consumer guard", () => {
  it("walks a client tree of the size it expects", () => {
    // Components, hooks and the `"use client"` pages come to roughly 885
    // modules; a set far below that means the directive check or the walk
    // broke, not that the tree got cleaner.
    expect(FILES.length).toBeGreaterThan(700);
  });

  for (const rule of RULES) {
    describe(rule.field, () => {
      it("every pattern still matches the shape it exists to catch", () => {
        for (const sample of rule.samples) {
          expect(
            rule.patterns.some((pattern) => pattern.test(sample)),
            `no pattern matched the sample: ${sample}`,
          ).toBe(true);
          expect(rule.unlessLine?.test(sample) ?? false).toBe(false);
        }
        // And each pattern earns its place with at least one sample.
        for (const pattern of rule.patterns) {
          expect(
            rule.samples.some((sample) => pattern.test(sample)),
            `pattern ${pattern} has no sample`,
          ).toBe(true);
        }
      });

      it(`is read from ${rule.servedBy}, never rebuilt in client code`, () => {
        const hits = matchesFor(rule);
        const offenders = [...hits.entries()]
          .filter(([rel]) => !(rel in rule.allow))
          .flatMap(([, lines]) => lines);
        expect(
          offenders,
          `client code rebuilds "${rule.field}" from its ingredients. ` +
            `Read the server's resolved value instead (${rule.servedBy}), ` +
            `or allowlist the file with the reason it is not a rebuild.`,
        ).toEqual([]);
      });

      it("has no stale allowlist entry", () => {
        const hits = matchesFor(rule);
        const stale = Object.keys(rule.allow).filter((rel) => !hits.has(rel));
        expect(
          stale,
          "allowlisted files that no longer match — remove the entry",
        ).toEqual([]);
      });
    });
  }

  it("reads a non-empty set of matches across the tree", () => {
    // The allowlisted readers are real matches; a guard whose matchers found
    // nothing anywhere would pass on any tree.
    const total = RULES.reduce(
      (sum, rule) =>
        sum + [...matchesFor(rule).values()].reduce((n, l) => n + l.length, 0),
      0,
    );
    expect(total).toBeGreaterThanOrEqual(6);
  });
});
