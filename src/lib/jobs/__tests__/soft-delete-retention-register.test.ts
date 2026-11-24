/**
 * Structural guard: every model that soft-deletes has exactly one retention
 * entry, and every entry names a model that soft-deletes.
 *
 * Twenty of the twenty-three soft-delete models had no purge at all: their
 * tombstones stayed for as long as the instance ran. The set is derived from
 * `prisma/schema.prisma` (a `deletedAt` field), so a model that starts
 * soft-deleting cannot ship without saying how long its tombstones live.
 *
 * The second half holds the live references. A key into a purged model that
 * does not cascade is a live record pointing at the tombstone (a visit naming
 * a deleted practitioner); the purge would null it and the record would stop
 * showing what it showed. Each such key must be one of the entry's
 * `referencedBy`, which keeps the tombstone while a live row holds it, and the
 * set is derived from the schema's `@relation` lines in both directions.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readDeclaredSchema,
  type DeclaredSchema,
} from "@/__tests__/helpers/prisma-schema-names";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";
import {
  SOFT_DELETE_RETENTION,
  purgeCondition,
  purgeModels,
  type LiveReferrer,
  type SoftDeleteRetention,
} from "@/lib/jobs/soft-delete-retention";

/**
 * Every key into a purged model that does not cascade, as the register spells
 * a referrer. A cascading key belongs to the row it points at (a visit's link
 * rows) and goes with it; any other `onDelete` (SetNull, Prisma's default for
 * an optional relation, Restrict, NoAction) leaves a live row behind.
 */
function nullingKeys(
  schema: DeclaredSchema,
  register: Readonly<Record<string, SoftDeleteRetention>>,
): Map<string, LiveReferrer[]> {
  const byTarget = new Map<string, LiveReferrer[]>();
  for (const model of schema.models) {
    const softDeletes = model.fields.some((f) => f.name === "deletedAt");
    for (const relation of model.relations) {
      if (register[relation.target]?.kind !== "purge") continue;
      if (relation.onDelete === "Cascade") continue;
      for (const key of relation.fields) {
        const column =
          model.fields.find((f) => f.name === key)?.physicalName ?? key;
        const list = byTarget.get(relation.target) ?? [];
        list.push({ table: model.physicalName, column, softDeletes });
        byTarget.set(relation.target, list);
      }
    }
  }
  return byTarget;
}

const refKey = (ref: LiveReferrer) =>
  `${ref.table}.${ref.column}${ref.softDeletes ? "" : " (no tombstone)"}`;

function referrerProblems(
  schema: DeclaredSchema,
  register: Readonly<Record<string, SoftDeleteRetention>>,
): string[] {
  const found: string[] = [];
  const derived = nullingKeys(schema, register);
  for (const [model, entry] of Object.entries(register)) {
    if (entry.kind !== "purge") continue;
    const want = new Set((derived.get(model) ?? []).map(refKey));
    const have = new Set((entry.referencedBy ?? []).map(refKey));
    for (const key of want) {
      if (!have.has(key)) {
        found.push(`${model}: ${key} does not cascade and is not a referrer`);
      }
    }
    for (const key of have) {
      if (!want.has(key)) {
        found.push(`${model}: referrer ${key} is not a nulling key`);
      }
    }
  }
  return found;
}

function problems(
  schema: DeclaredSchema,
  register: Readonly<Record<string, SoftDeleteRetention>>,
): string[] {
  const found: string[] = [];
  const softDeleting = schema.models.filter((model) =>
    model.fields.some((f) => f.name === "deletedAt"),
  );
  for (const model of softDeleting) {
    const entry = register[model.name];
    if (!entry) {
      found.push(`${model.name}: soft-deletes but has no retention entry`);
      continue;
    }
    if (entry.kind !== "purge") continue;
    if (entry.table !== model.physicalName) {
      found.push(
        `${model.name}: entry purges ${entry.table}, the model is ${model.physicalName}`,
      );
    }
    for (const column of ["user_id", "deleted_at"]) {
      if (!model.fields.some((f) => f.physicalName === column)) {
        found.push(`${model.name}: the purge needs a ${column} column`);
      }
    }
  }
  const names = new Set(softDeleting.map((m) => m.name));
  for (const name of Object.keys(register)) {
    if (!names.has(name)) {
      found.push(`${name}: has a retention entry but does not soft-delete`);
    }
  }
  return found;
}

describe("soft-delete retention register", () => {
  const schema = readDeclaredSchema();

  it("covers every soft-delete model exactly once", () => {
    const softDeleting = schema.models.filter((model) =>
      model.fields.some((f) => f.name === "deletedAt"),
    );
    // A reader that stopped matching would find nothing and pass.
    expect(softDeleting.length).toBeGreaterThanOrEqual(23);
    const found = problems(schema, SOFT_DELETE_RETENTION);
    expect(found, found.join("\n")).toEqual([]);
  });

  it("keeps every tombstone at least as long as the sync feed's horizon", () => {
    for (const [model, entry] of Object.entries(SOFT_DELETE_RETENTION)) {
      if (entry.kind !== "purge") continue;
      expect(entry.days(), model).toBeGreaterThanOrEqual(
        TOMBSTONE_RETENTION_DAYS,
      );
    }
    expect(purgeModels()).toContain("MenstrualCycle");
    expect(purgeModels()).toContain("CycleDayLog");
  });

  it("explains every entry that departs from the default", () => {
    for (const [model, entry] of Object.entries(SOFT_DELETE_RETENTION)) {
      if (entry.kind !== "purge") continue;
      const departs =
        entry.keep !== undefined || entry.days() !== TOMBSTONE_RETENTION_DAYS;
      if (departs) expect(entry.why?.length ?? 0, model).toBeGreaterThan(40);
    }
  });

  it("holds every tombstone a live row still points at", () => {
    const derived = nullingKeys(schema, SOFT_DELETE_RETENTION);
    // A reader that stopped seeing relations would derive nothing and pass.
    const count = [...derived.values()].reduce((n, l) => n + l.length, 0);
    expect(count).toBeGreaterThanOrEqual(9);
    expect(derived.get("Practitioner")?.map(refKey)).toEqual([
      "encounters.practitioner_id",
      "treatment_series.prescriber_id",
      "treatment_series.performer_id",
      "vaccination_records.practitioner_id",
    ]);
    const found = referrerProblems(schema, SOFT_DELETE_RETENTION);
    expect(found, found.join("\n")).toEqual([]);
  });

  it("turns every referrer into a live-row condition", () => {
    const entry = SOFT_DELETE_RETENTION.Practitioner;
    if (entry.kind !== "purge") throw new Error("Practitioner is purged");
    const sql = purgeCondition(entry);
    expect(sql).toContain(
      `NOT EXISTS (SELECT 1 FROM "encounters" r WHERE r."practitioner_id" = t."id" AND r."deleted_at" IS NULL)`,
    );
    // Symptom occurrences tombstone their Apple Health imports, so only a
    // live one holds its episode back.
    const symptoms = SOFT_DELETE_RETENTION.IllnessEpisode;
    if (symptoms.kind !== "purge") throw new Error("IllnessEpisode is purged");
    expect(purgeCondition(symptoms)).toContain(
      `NOT EXISTS (SELECT 1 FROM "symptom_events" r WHERE r."episode_id" = t."id" AND r."deleted_at" IS NULL)`,
    );
    // A table without tombstones: every row is live.
    expect(
      purgeCondition({
        kind: "purge",
        table: "widgets",
        days: () => 1,
        referencedBy: [
          { table: "widget_uses", column: "widget_id", softDeletes: false },
        ],
      }),
    ).toContain(
      `NOT EXISTS (SELECT 1 FROM "widget_uses" r WHERE r."widget_id" = t."id")`,
    );
    expect(() =>
      purgeCondition({
        kind: "purge",
        table: "widgets",
        days: () => 75,
        referencedBy: [{ table: "x; DROP", column: "a", softDeletes: true }],
      }),
    ).toThrow("Bad referrer");
  });

  it("counter-check: names a new nulling key and a stale referrer", () => {
    const dir = mkdtempSync(join(tmpdir(), "hl-retention-"));
    try {
      const path = join(dir, "schema.prisma");
      writeFileSync(
        path,
        `model Widget {
  id        String    @id
  userId    String    @map("user_id")
  deletedAt DateTime? @map("deleted_at")
  @@map("widgets")
}
model Note {
  id        String    @id
  widgetId  String?   @map("widget_id")
  ownerId   String?   @map("owner_id")
  deletedAt DateTime? @map("deleted_at")
  widget    Widget?   @relation(fields: [widgetId], references: [id], onDelete: SetNull)
  owner     Widget?   @relation("Owned", fields: [ownerId], references: [id])
  @@map("notes")
}
model Part {
  id       String @id
  widgetId String @map("widget_id")
  widget   Widget @relation(fields: [widgetId], references: [id], onDelete: Cascade)
  @@map("parts")
}
`,
      );
      const synthetic = readDeclaredSchema(path);
      const found = referrerProblems(synthetic, {
        Widget: {
          kind: "purge",
          table: "widgets",
          days: () => 75,
          referencedBy: [
            { table: "notes", column: "widget_id", softDeletes: true },
            { table: "gone", column: "widget_id", softDeletes: false },
          ],
        },
      });
      // The SetNull key is handled, the default-`onDelete` key is not, the
      // cascading key is owned, and the stale referrer is named.
      expect(found).toEqual([
        "Widget: notes.owner_id does not cascade and is not a referrer",
        "Widget: referrer gone.widget_id (no tombstone) is not a nulling key",
      ]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("counter-check: names a new soft-delete model, a stale entry and a wrong table", () => {
    const dir = mkdtempSync(join(tmpdir(), "hl-retention-"));
    try {
      const path = join(dir, "schema.prisma");
      writeFileSync(
        path,
        `model Widget {
  id        String    @id
  userId    String    @map("user_id")
  deletedAt DateTime? @map("deleted_at")
  @@map("widgets")
}
model Gadget {
  id        String    @id
  userId    String    @map("user_id")
  deletedAt DateTime? @map("deleted_at")
  @@map("gadgets")
}
`,
      );
      const synthetic = readDeclaredSchema(path);
      const found = problems(synthetic, {
        Gadget: { kind: "purge", table: "gadget", days: () => 75 },
        Gone: { kind: "purge", table: "gone", days: () => 75 },
      });
      expect(found).toEqual([
        "Widget: soft-deletes but has no retention entry",
        "Gadget: entry purges gadget, the model is gadgets",
        "Gone: has a retention entry but does not soft-delete",
      ]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
