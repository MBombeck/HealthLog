/**
 * Cycle-tracking per-user settings row.
 *
 * `CycleProfile` is a 1:1 settings row (one per user, `@@unique(userId)`)
 * that holds the goal + prediction / privacy preferences. There is no
 * onboarding step that creates it eagerly; instead the read path lazily
 * upserts a default row on first cycle-surface access, exactly like the
 * other upsert-on-read settings rows in the tree (the Coach usage ledger
 * in `src/lib/ai/coach/budget.ts`). The default goal is `GENERAL_HEALTH`
 * — the inclusive, conception-framing-free default — and
 * `sensitiveCategoryEncryption` defaults ON for this category given the
 * reproductive-health threat model.
 */
import { prisma } from "@/lib/db";
import type { CycleProfile, Prisma } from "@/generated/prisma/client";

/**
 * Return the user's `CycleProfile`, creating a default row on first
 * access. Idempotent + race-safe: the `(userId)` unique lets the upsert
 * collapse concurrent first-reads to a single row (a second caller's
 * `create` loses the race and falls through to the no-op update).
 */
export async function getOrCreateCycleProfile(
  userId: string,
  db: Pick<Prisma.TransactionClient, "cycleProfile"> = prisma,
): Promise<CycleProfile> {
  return db.cycleProfile.upsert({
    where: { userId },
    // Field-by-field create (no mass assignment): every default is the
    // schema default, spelled out so the row shape is explicit at the
    // call site.
    create: { userId },
    // No-op on an existing row — `update: {}` keeps the upsert a pure
    // get-or-create without touching the stored preferences.
    update: {},
  });
}
