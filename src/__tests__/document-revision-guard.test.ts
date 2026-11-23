/**
 * Structural guards on the settings-document lock tokens.
 *
 * The behaviour is proved against the real database in
 * `tests/integration/routes/document-revision-lock.test.ts`: a write to
 * another column of the same row leaves a document's token alone, and a save
 * on the token it read succeeds. This file freezes what tomorrow's code may
 * not do:
 *
 *   * no guarded surface reads a row's `updatedAt` as its token again (the
 *     class that made every settings save answer 409 for minutes after any
 *     other write to the account row);
 *   * the documents the lock helper names and the columns the trigger moves
 *     are the same set, so a document added to one and not the other fails;
 *   * the revision columns are named by a closed list of files: the lock
 *     helper and the reads and guards that serve or compare a token. Any
 *     other writer must change the document and let the database move the
 *     token, never set it.
 *
 * What the matchers cannot see: a lock token under another field name than
 * `baseUpdatedAt`, or one compared by hand without `takeBaseToken`. Every leg
 * asserts a non-zero match count first, so a matcher that stops matching
 * fails instead of passing on an empty set.
 */
import { describe, expect, it } from "vitest";

import { readSource, readSourceFolder } from "@/__tests__/helpers/source-files";
import { USER_DOCUMENT_REVISION } from "@/lib/optimistic-lock";

const files = readSourceFolder("src", {
  floor: 1000,
  include: (rel) =>
    !rel.startsWith("generated/") &&
    !rel.includes("__tests__/") &&
    !/\.test\.tsx?$/.test(rel),
}).map(([rel, text]) => ({ path: `src/${rel}`, text }));

const snake = (camel: string) =>
  camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe("settings-document lock tokens", () => {
  it("never reads a row's updatedAt where a base token is taken", () => {
    const guarded = files.filter(
      (f) =>
        /\btakeBaseToken\(|\bbaseUpdatedAt\b/.test(f.text) &&
        /^src\/(app\/api|lib)\//.test(f.path) &&
        !f.path.startsWith("src/lib/openapi/") &&
        !f.path.startsWith("src/lib/validations/"),
    );
    expect(guarded.length).toBeGreaterThanOrEqual(9);
    const offenders = guarded
      .filter((f) =>
        /\bupdatedAt:\s*(true|base)\b|\.updatedAt\??\.(toISOString|getTime)\(/.test(
          f.text,
        ),
      )
      .map((f) => f.path);
    expect(
      offenders,
      "a lock token is the document's own revision (`src/lib/optimistic-lock.ts`), never the row's updatedAt",
    ).toEqual([]);
  });

  it("moves exactly the documents the lock helper names", () => {
    const migration = readSource(
      "prisma/migrations/0554_document_revisions/migration.sql",
      '"users_bump_document_revisions"',
    );
    const usersFn = migration.slice(
      migration.indexOf('"users_bump_document_revisions"'),
      migration.indexOf('"users_document_revision_bump"'),
    );
    const moved = [...usersFn.matchAll(/NEW\."(\w+_revised_at)" :=/g)].map(
      (m) => m[1],
    );
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.sort()).toEqual(
      Object.values(USER_DOCUMENT_REVISION).map(snake).sort(),
    );
  });

  it("names the revision columns in a closed list of files", () => {
    const naming = files
      .filter((f) => /\b\w+RevisedAt\b/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(naming.length).toBeGreaterThan(0);
    expect(naming).toEqual(
      [
        // The helper: the document map, the guard and the token reads.
        "src/lib/optimistic-lock.ts",
        // Reads that serve a document with its token.
        "src/app/api/auth/me/coach-prefs/route.ts",
        "src/app/api/auth/me/health-score-config/route.ts",
        "src/app/api/auth/me/modules/route.ts",
        "src/app/api/auth/me/notification-prefs/route.ts",
        "src/app/api/insights/layout/route.ts",
        "src/app/api/medications/layout/route.ts",
        "src/app/api/mood/tags/layout/route.ts",
        "src/lib/dashboard/widgets/read-layout.ts",
        // The about-me document on `user_health_profiles`.
        "src/app/api/coach/about-me/route.ts",
        "src/lib/ai/coach/about-me.ts",
        "src/lib/profile/life-circumstances.ts",
        // Verdicts only: never carried by a backup, never reset by a wipe.
        "src/lib/export/account-settings-classes.ts",
        "src/lib/data-wipe/wipe-plan.ts",
      ].sort(),
    );
  });
});
