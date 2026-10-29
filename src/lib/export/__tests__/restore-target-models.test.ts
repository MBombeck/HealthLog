/**
 * The emptiness check behind restoring an erased account's copy into another
 * account reads every backed-up model by its `userId`, except the children
 * that have none, which it reaches through their parent. Both halves are held
 * to `prisma/schema.prisma` here, so a backed-up model added later is either
 * checked or fails this file; it cannot be skipped and read as empty.
 *
 * Mutation check: drop a model from `BACKED_UP_CHILD_MODELS` and the first
 * case names it (no `userId`); add an owned model to it and the second does.
 */
import { describe, expect, it } from "vitest";

import { parseWipeSchema } from "@/__tests__/helpers/wipe-schema-shape";
import { BACKED_UP_MODELS } from "@/lib/export/backup-plan";
import {
  BACKED_UP_CHILD_MODELS,
  RESTORE_TARGET_OWNED_MODELS,
} from "@/lib/export/restore-target";

const models = parseWipeSchema();

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
});
