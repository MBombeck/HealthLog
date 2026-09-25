import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUTH_MODELS_OUT_OF_SCOPE,
  BACKED_UP_MODELS,
  DERIVED_MODELS,
  NOT_IN_BACKUP_MODELS,
  backupVerdict,
} from "@/lib/export/backup-plan";

/**
 * Every model in the schema has a written verdict about the backup.
 *
 * This is the first of three checks on that claim, and the weakest one on
 * purpose — it asks only whether a decision was written down.
 *
 *   1. here — every user-scoped model has a verdict, and every verdict names a
 *      model the schema still has.
 *   2. below — every model claimed two-ended has a payload reader and a restore
 *      branch in the declared files. Source text, so it sees code that was
 *      never written and not code that never runs.
 *   3. `tests/integration/backup-round-trip.test.ts` — a seeded row of every
 *      two-ended model exported, the account emptied, the restore run, the row
 *      counted back. The only one of the three that can tell a restore branch
 *      that runs from one that merely exists.
 *
 * An earlier version of this comment said the second half did not exist and
 * that `BACKED_UP` therefore meant "must be carried" rather than "is carried".
 * Both halves exist now; the sentence is rewritten rather than deleted because
 * the sequence is the point — the classification was written first and was
 * mistaken for proof for several releases.
 *
 * The failure all three prevent: a model is added to `schema.prisma`, it is
 * user-scoped from birth, and it is outside the backup by default. Nothing
 * notices, and the gap is only discovered by someone restoring a backup and
 * finding a part of their record missing — which is the worst possible moment
 * and the worst possible messenger.
 */

const SCHEMA_PATH = resolve(__dirname, "../../prisma/schema.prisma");

/** Models declared in the schema, minus `User` itself (the account row). */
function schemaModels(): string[] {
  const source = readFileSync(SCHEMA_PATH, "utf8");
  return [...source.matchAll(/^model\s+(\w+)\s*\{/gm)]
    .map((m) => m[1])
    .filter((name) => name !== "User");
}

/**
 * Models with no `userId` and no relation to `User` are instance-scoped (queue
 * tables, rate-limit buckets, invite codes the operator issues). They are not
 * an account's data and the wipe plan already declares them as such.
 *
 * The relation check is on the TYPE, not on the field name. It used to require
 * a field literally called `user`, which meant a model naming its account
 * relations anything else — `grantor`/`grantee` on an account grant, say —
 * read as instance-scoped and was excused from having a verdict at all. A
 * guard that lets the newest table through is the shape of guard this file
 * exists to prevent, so it reads the type.
 */
function isUserScoped(model: string): boolean {
  const source = readFileSync(SCHEMA_PATH, "utf8");
  const block = new RegExp(
    `^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`,
    "m",
  ).exec(source);
  if (!block) return false;
  const body = block[1];
  return /\buserId\b/.test(body) || /^\s*\w+\s+User(\[\]|\?)?\s/m.test(body);
}

describe("every schema model has a backup verdict", () => {
  const models = schemaModels();

  it("reads a schema with models in it (no vacuous pass)", () => {
    expect(models.length).toBeGreaterThan(50);
  });

  it("classifies every user-scoped model", () => {
    const unclassified = models
      .filter(isUserScoped)
      .filter((m) => backupVerdict(m) === null);

    if (unclassified.length > 0) {
      throw new Error(
        `${unclassified.length} user-scoped model(s) have no backup verdict:\n\n` +
          unclassified.map((m) => `  ❌ ${m}`).join("\n") +
          "\n\nAdd each to src/lib/export/backup-plan.ts: to BACKED_UP_MODELS if an " +
          "account would lose something real without it, to DERIVED_MODELS with what " +
          "rebuilds it, or to NOT_IN_BACKUP_MODELS with why it must not travel. " +
          "A new model is user-scoped from birth and outside the backup by default, " +
          "which is exactly the silence this test exists to break.",
      );
    }
  });

  it("carries no verdict for a model the schema no longer has", () => {
    const known = new Set(models);
    const stale = [
      ...BACKED_UP_MODELS,
      ...Object.keys(DERIVED_MODELS),
      ...Object.keys(NOT_IN_BACKUP_MODELS),
      ...AUTH_MODELS_OUT_OF_SCOPE,
    ].filter((m) => !known.has(m));

    expect(
      stale,
      `verdicts for models that no longer exist: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("gives each model exactly one verdict", () => {
    const seen = new Map<string, string[]>();
    const add = (model: string, list: string) => {
      seen.set(model, [...(seen.get(model) ?? []), list]);
    };
    for (const m of BACKED_UP_MODELS) add(m, "BACKED_UP");
    for (const m of Object.keys(DERIVED_MODELS)) add(m, "DERIVED");
    for (const m of Object.keys(NOT_IN_BACKUP_MODELS)) add(m, "NOT_IN_BACKUP");
    for (const m of AUTH_MODELS_OUT_OF_SCOPE) add(m, "AUTH");

    const doubled = [...seen.entries()].filter(([, lists]) => lists.length > 1);
    expect(
      doubled.map(([m, lists]) => `${m}: ${lists.join(" + ")}`),
      "a model classified twice means two readers can each believe the other handles it",
    ).toEqual([]);
  });

  it("gives every excluded model a reason, not an empty string", () => {
    const empty = [
      ...Object.entries(DERIVED_MODELS),
      ...Object.entries(NOT_IN_BACKUP_MODELS),
    ]
      // 20 characters let "Same as WithingsConnection." through, which is a
      // pointer rather than a reason: if the entry it points at changes, this
      // one silently inherits something else. 60 forces the decision to be
      // written where it is made.
      .filter(([, reason]) => reason.trim().length < 60)
      .map(([model]) => model);
    expect(
      empty,
      "a one-word reason is how a decision stops being reviewable",
    ).toEqual([]);
  });

  it("excludes Guardian egress claims rather than exporting delivery metadata", () => {
    expect(backupVerdict("NotificationEgressAuthorization")).toBe(
      "NOT_IN_BACKUP",
    );
    expect(NOT_IN_BACKUP_MODELS.NotificationEgressAuthorization).toMatch(
      /no notification content, credentials, or deduplication key/i,
    );
  });
});

/**
 * The second half of the guard: a `BACKED_UP` model either travels BOTH ways or
 * is named as debt.
 *
 * The first half above proves every model has an opinion. It would pass
 * unchanged while a model classified as carried was read into the payload and
 * never written back — which is not a hypothetical, it is what happened to the
 * nutrient day totals, to the custom mood tags, and to the custom cycle
 * symptoms, three releases running.
 *
 * The check reads the declared writer and restore files rather than grepping
 * for a route, BECAUSE the route delegates. A review that grepped only
 * `restore/route.ts` concluded the cycle data was never restored and had to be
 * retracted; `restoreCycleData` and `restoreProfileData` both live elsewhere.
 * Following the helpers is the entire difficulty of this question, so the file
 * list is declared next to the verdicts and checked to exist.
 *
 * ── What reading source text cannot answer ──────────────────────────────────
 *
 * A branch that exists and never runs. Wrapping the nutrient restore in
 * `if (false && …)` leaves every check in this file green, because the call is
 * still written where the matcher looks. Same for a restore that writes into
 * the wrong account, or a transaction that rolls back. The round-trip test
 * named above is what answers those, and the reason it is worth its runtime.
 *
 * A model the matcher cannot tell apart from another is named in
 * {@link STRUCTURALLY_UNATTRIBUTABLE} with what defeats it, and is checked here
 * only for being covered by the round trip.
 */

import {
  BACKUP_RESTORE_FILES,
  BACKUP_WRITER_FILES,
  COVERAGE_PENDING,
  STRUCTURALLY_UNATTRIBUTABLE,
  TWO_ENDED_MODELS,
} from "@/lib/export/backup-plan";

/**
 * The behavioural half, checked from here only for its coverage.
 *
 * It seeds a row per two-ended model, exports through the real builder, empties
 * the account and restores through the real route, so it is the only check that
 * can tell a restore branch that RUNS from one that merely exists — this file
 * stayed green with the nutrient restore wrapped in `if (false)`.
 */
const ROUND_TRIP_TEST = "tests/integration/backup-round-trip.test.ts";

const REPO_ROOT = resolve(__dirname, "../..");

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

/** `Measurement` → `measurement`, the Prisma delegate name. */
function delegateName(model: string): string {
  return model[0].toLowerCase() + model.slice(1);
}

/**
 * Relation fields on OTHER models whose type is `model`, each with the model
 * that declares it.
 *
 * A child rides its parent — `include: { schedules: true }` on the way out,
 * `schedules: { create: [...] }` on the way back — so a delegate-only search
 * would report every nested child as uncarried and the guard would be noise.
 *
 * The declaring parent comes back with the field name because a field name on
 * its own is not evidence about a model. `symptomLinks` is declared twice —
 * once on `IllnessDayLog` for `IllnessSymptomLink`, once on `CycleDayLog` for
 * `CycleSymptomLink` — and a search for the bare name found the cycle write in
 * `src/lib/cycle/backup.ts` and reported the ILLNESS link covered. Verified by
 * deleting the illness `symptomLinks: { create: … }` branch from the restore
 * route outright: the guard stayed green on all twelve checks, because the
 * cycle file was answering a question about a different table.
 */
function relationParents(model: string): Array<{
  field: string;
  parent: string;
}> {
  const source = readFileSync(SCHEMA_PATH, "utf8");
  const found: Array<{ field: string; parent: string }> = [];
  for (const [, parent, body] of source.matchAll(
    /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm,
  )) {
    for (const line of body.split("\n")) {
      const match = /^\s*(\w+)\s+(\w+)(\[\])?\??\s*(@|$)/.exec(line);
      if (match && match[2] === model) {
        found.push({ field: match[1], parent });
      }
    }
  }
  return found;
}

const READ_OPS = /(findMany|findUnique|findFirst|findUniqueOrThrow|groupBy)/;
const WRITE_OPS = /(create|createMany|upsert|update|updateMany)/;
const READ_RELATION_OPS = /[{[t]/;
const WRITE_RELATION_OPS = /\{\s*create\b/;

/** Does `source` call a matching operation on `model`'s own Prisma delegate? */
function callsDelegate(source: string, model: string, ops: RegExp): boolean {
  const delegate = delegateName(model);
  for (const match of source.matchAll(
    new RegExp(`\\.${delegate}\\s*\\.\\s*(\\w+)`, "g"),
  )) {
    if (ops.test(match[1])) return true;
  }
  return false;
}

/** Every model a relation field of this name points at, across the schema. */
function targetsOfRelationField(field: string): Set<string> {
  const source = readFileSync(SCHEMA_PATH, "utf8");
  const targets = new Set<string>();
  for (const [, body] of source.matchAll(/^model\s+\w+\s*\{([\s\S]*?)^\}/gm)) {
    for (const line of body.split("\n")) {
      const match = /^\s*(\w+)\s+(\w+)(\[\])?\??\s*(@|$)/.exec(line);
      if (match && match[1] === field) targets.add(match[2]);
    }
  }
  return targets;
}

/**
 * Does any of `files` touch `model` through matching delegate and relation
 * operations?
 *
 * A relation field name that points at exactly ONE model anywhere in the schema
 * is evidence wherever it appears in the declared files — `schedules` can only
 * mean `MedicationSchedule`.
 *
 * A name that points at SEVERAL models is evidence only in a file that also
 * operates on the declaring parent's delegate, because otherwise the two
 * writes are indistinguishable and either model answers for the other.
 */
function touches(
  files: readonly string[],
  model: string,
  delegateOps: RegExp,
  relationOps: RegExp,
): boolean {
  return files.some((file) => {
    // Whitespace-flattened so a call broken across lines still matches.
    const source = read(file).replace(/\s+/g, " ");
    if (callsDelegate(source, model, delegateOps)) return true;
    return relationParents(model).some(({ field, parent }) => {
      if (
        !new RegExp(`\\b${field}\\s*:\\s*(?:${relationOps.source})`).test(
          source,
        )
      ) {
        return false;
      }
      if (targetsOfRelationField(field).size === 1) return true;
      return callsDelegate(source, parent, delegateOps);
    });
  });
}

describe("every backed-up model travels both ways, or is named as debt", () => {
  it("does not count a nested relation read as a restore write", () => {
    expect(
      touches(
        ["src/lib/export/restore-backup.ts"],
        "User",
        WRITE_OPS,
        WRITE_RELATION_OPS,
      ),
    ).toBe(false);
  });

  it("does not accept a relation name borrowed from another parent", () => {
    // `src/lib/cycle/backup.ts` writes `symptomLinks: { create: … }` for
    // `CycleDayLog`. The same field name belongs to `IllnessDayLog`, so the
    // bare-name search read that line as proof the illness links are restored.
    // The cycle file must answer for the cycle link and for nothing else.
    expect(
      touches(
        ["src/lib/cycle/backup.ts"],
        "CycleSymptomLink",
        WRITE_OPS,
        WRITE_RELATION_OPS,
      ),
      "the cycle file does write the cycle link — this half must stay true",
    ).toBe(true);
    expect(
      touches(
        ["src/lib/cycle/backup.ts"],
        "IllnessSymptomLink",
        WRITE_OPS,
        WRITE_RELATION_OPS,
      ),
      "the cycle file says nothing about illness links and must not be read as if it did",
    ).toBe(false);
  });

  it("declares writer and restore files that exist", () => {
    for (const file of [...BACKUP_WRITER_FILES, ...BACKUP_RESTORE_FILES]) {
      expect(() => read(file), `${file} is declared but missing`).not.toThrow();
    }
    // A grep of the restore ROUTE alone is the mistake this list prevents, so
    // the list has to name more than the route.
    expect(BACKUP_RESTORE_FILES.length).toBeGreaterThan(1);
  });

  it("splits BACKED_UP into exactly two-ended and pending, with no overlap", () => {
    const backedUp = new Set<string>(BACKED_UP_MODELS);
    const twoEnded = new Set<string>(TWO_ENDED_MODELS);
    const pending = new Set(Object.keys(COVERAGE_PENDING));

    const both = [...twoEnded].filter((m) => pending.has(m));
    expect(
      both,
      "a model cannot be both proven and pending — that is how a gap hides",
    ).toEqual([]);

    const unaccounted = [...backedUp].filter(
      (m) => !twoEnded.has(m) && !pending.has(m),
    );
    expect(
      unaccounted,
      "add each to TWO_ENDED_MODELS once its reader AND restore branch land, " +
        "or to COVERAGE_PENDING with what an account loses meanwhile",
    ).toEqual([]);

    const foreign = [...twoEnded, ...pending].filter((m) => !backedUp.has(m));
    expect(
      foreign,
      "only a BACKED_UP model has two ends to have; these are not on that list",
    ).toEqual([]);
  });

  it("finds a payload reader for every model claimed two-ended", () => {
    const missing = TWO_ENDED_MODELS.filter(
      (model) =>
        !(model in STRUCTURALLY_UNATTRIBUTABLE) &&
        !touches(BACKUP_WRITER_FILES, model, READ_OPS, READ_RELATION_OPS),
    );
    expect(
      missing,
      "claimed carried, but no backup writer reads it — the restore branch has " +
        "nothing feeding it and a restore silently rebuilds the account without it",
    ).toEqual([]);
  });

  it("finds a restore branch for every model claimed two-ended", () => {
    const missing = TWO_ENDED_MODELS.filter(
      (model) =>
        !(model in STRUCTURALLY_UNATTRIBUTABLE) &&
        !touches(BACKUP_RESTORE_FILES, model, WRITE_OPS, WRITE_RELATION_OPS),
    );
    expect(
      missing,
      "claimed carried, but nothing writes it back — the export is a file the " +
        "restore reads past, which is the worst of both: the data is in the " +
        "backup and not in the account",
    ).toEqual([]);
  });

  it("hands every unattributable model to the round trip instead", () => {
    const names = Object.keys(STRUCTURALLY_UNATTRIBUTABLE);
    const foreign = names.filter(
      (m) => !(TWO_ENDED_MODELS as readonly string[]).includes(m),
    );
    expect(
      foreign,
      "only a model claimed two-ended has a claim for this check to be unable to attribute",
    ).toEqual([]);

    const thin = Object.entries(STRUCTURALLY_UNATTRIBUTABLE)
      .filter(([, reason]) => reason.trim().length < 60)
      .map(([model]) => model);
    expect(
      thin,
      "say what defeats the matcher, or the next reader cannot tell an " +
        "unprovable model from an unproven one",
    ).toEqual([]);

    // Naming a model here silences the two checks above, so it has to buy that
    // silence with a seeded row in the round trip. Without this the record is
    // a way to make any model's coverage question disappear.
    const roundTrip = read(ROUND_TRIP_TEST);
    const uncovered = names.filter(
      (model) => !new RegExp(`\\b${model}\\s*:`).test(roundTrip),
    );
    expect(
      uncovered,
      `exempt from the structural check and absent from ${ROUND_TRIP_TEST} — ` +
        "that is not a limitation being recorded, it is a model with nothing " +
        "checking it at all",
    ).toEqual([]);
  });

  it("gives every pending model a reason that says what is lost", () => {
    const thin = Object.entries(COVERAGE_PENDING)
      .filter(([, reason]) => reason.trim().length < 60)
      .map(([model]) => model);
    expect(
      thin,
      "'not yet' is not a reason — say what an account loses, so the debt can " +
        "be ordered by cost to a person rather than by ease of writing",
    ).toEqual([]);
  });

  it("proves the reminder engine models are on the covered side", () => {
    // v1.37.20 (#223 / iOS #68) — the reminder came off the debt register and
    // the completion ledger landed carried from the release that introduced
    // it. Pinned by name so a future edit cannot quietly move either back to
    // COVERAGE_PENDING: the ledger is the only copy of every satisfy and skip
    // before the latest one, so "pending" would be a silent history loss, not
    // a deferral.
    for (const model of ["MeasurementReminder", "MeasurementReminderEvent"]) {
      expect(BACKED_UP_MODELS).toContain(model);
      expect(TWO_ENDED_MODELS).toContain(model);
      expect(COVERAGE_PENDING).not.toHaveProperty(model);
    }
  });

  it("proves the structured-profile models are on the covered side", () => {
    // These account-owned rows are exported and restored explicitly rather
    // than being treated as reconstructible data.
    for (const model of [
      "UserHealthProfile",
      "HealthProfileFactRevision",
      "CustomMetric",
      "CustomMetricEntry",
    ]) {
      expect(BACKED_UP_MODELS).toContain(model);
      expect(TWO_ENDED_MODELS).toContain(model);
      expect(COVERAGE_PENDING).not.toHaveProperty(model);
    }
  });
});
