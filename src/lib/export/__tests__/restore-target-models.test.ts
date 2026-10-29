/**
 * The emptiness check behind restoring an erased account's copy into another
 * account reads every backed-up model by its `userId`, except the children
 * that have none, which it reaches through their parent. Both halves are held
 * to `prisma/schema.prisma` here, so a backed-up model added later is either
 * checked or fails this file; it cannot be skipped and read as empty.
 *
 * Mutation check: drop a model from `BACKED_UP_CHILD_MODELS` and the first
 * case names it (no `userId`); add an owned model to it and the second does.
 * Add a model with many rows per account (`Measurement`) to the setup list
 * and the third does.
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import {
  parseWipeSchema,
  WIPE_SCHEMA_PATH,
} from "@/__tests__/helpers/wipe-schema-shape";
import { BACKED_UP_MODELS } from "@/lib/export/backup-plan";
import {
  BACKED_UP_CHILD_MODELS,
  RESTORE_TARGET_OWNED_MODELS,
  RESTORE_TARGET_SETUP_MODELS,
} from "@/lib/export/restore-target";

const models = parseWipeSchema();
const SCHEMA = readFileSync(WIPE_SCHEMA_PATH, "utf8");

describe("restore target models", () => {
  it("reads every owned backed-up model by its userId", () => {
    const missing = RESTORE_TARGET_OWNED_MODELS.filter(
      (model) => !models.get(model)?.scalars.includes("userId"),
    );
    expect(missing).toEqual([]);
    expect(RESTORE_TARGET_OWNED_MODELS.length).toBeGreaterThan(60);
  });

  it("reaches each child through a required cascade to an owned parent", () => {
    for (const [child, parent] of Object.entries(BACKED_UP_CHILD_MODELS)) {
      expect(BACKED_UP_MODELS, child).toContain(child);
      const shape = models.get(child);
      expect(shape?.scalars, child).not.toContain("userId");
      expect(
        shape?.relations.some(
          (r) => r.target === parent && r.cascade && !r.optional,
        ),
        `${child} -> ${parent}`,
      ).toBe(true);
      expect(RESTORE_TARGET_OWNED_MODELS, parent).toContain(parent);
    }
  });

  it("leaves out only one-row-per-account setup state that no other backed-up model hangs off", () => {
    const setup = Object.keys(RESTORE_TARGET_SETUP_MODELS);
    expect(setup.sort()).toEqual(["CycleProfile", "OnboardingRecord"]);
    for (const model of setup) {
      expect(RESTORE_TARGET_OWNED_MODELS, model).toContain(model);
      // One row per account: a list of things the person recorded is not
      // setup state.
      const body = SCHEMA.match(
        new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m"),
      )?.[1];
      expect(
        /^\s*userId\s+String\s+@unique/m.test(body ?? "") ||
          /@@unique\(\[userId\]\)/.test(body ?? ""),
        model,
      ).toBe(true);
      // Nothing backed up hangs off it, so leaving it out of the check
      // leaves no record unchecked behind it.
      for (const other of BACKED_UP_MODELS) {
        expect(
          models.get(other)?.relations.some((r) => r.target === model),
          `${other} -> ${model}`,
        ).not.toBe(true);
      }
    }
  });
});
