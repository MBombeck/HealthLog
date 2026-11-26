/**
 * Ending an account's sessions goes through one function.
 *
 * Deleting the `session` rows ends the browser and nothing else: the native
 * app's refresh token family, its paired access token, programmatic API
 * tokens and the device's push credentials all survive it. The admin force
 * logout did exactly that, and the app stayed signed in for the rest of its
 * refresh window. Every action that ends a whole account's sessions now runs
 * `destroyAllSessions` (or, inside the account-deletion lock, the same
 * `credentialRevocations` list), and an action that keeps the caller's own
 * credential runs `destroyOtherSessions`.
 *
 * This guard holds every `session.deleteMany` in the source to the files
 * below, with their counts. A new one fails until it is looked at here: if it
 * ends an account's sign-ins, it belongs in `destroyAllSessions` instead.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  readSource,
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const SESSION_DELETERS: Record<string, { deletes: number; why: string }> = {
  "lib/auth/credential-revocations.ts": {
    deletes: 1,
    why: "the one list of statements that ends every credential, run by destroyAllSessions and the account-deletion lock",
  },
  "lib/auth/session.ts": {
    deletes: 3,
    why: "getSession dropping the one expired or unusable row it was handed, destroyOtherSessions (revokes the refresh tokens and paired access tokens in the same transaction) and destroySessionById (one web session the owner picked)",
  },
  "lib/auth/cookie-identity-conflict.ts": {
    deletes: 1,
    why: "the one session row of another account whose cookie rode beside a Bearer token; the token's own account keeps its sign-ins",
  },
  "lib/account-deletion/lifecycle.ts": {
    deletes: 1,
    why: "eraseAccount, right before the account row is deleted and every other credential cascades with it",
  },
};

function countDeletes(source: string): number {
  return (
    stripComments(source).match(/\bsession\s*\.\s*deleteMany\s*\(/g)?.length ??
    0
  );
}

describe("ending an account's sessions", () => {
  const found = new Map<string, number>();
  for (const rel of walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))) {
    const n = countDeletes(readSourceText(join(SRC, rel)));
    if (n > 0) found.set(rel, n);
  }

  it("finds the deletes at all (a matcher that matches nothing is no guard)", () => {
    expect(found.size).toBeGreaterThanOrEqual(3);
    expect(
      countDeletes("await tx.session\n  .deleteMany({ where: { userId } })"),
    ).toBe(1);
    expect(countDeletes("// prisma.session.deleteMany({})")).toBe(0);
  });

  it("deletes session rows only in the listed places", () => {
    expect(Object.fromEntries(found)).toEqual(
      Object.fromEntries(
        Object.entries(SESSION_DELETERS).map(([f, d]) => [f, d.deletes]),
      ),
    );
  });

  it("routes the admin force logout through destroyAllSessions", () => {
    const route = stripComments(
      readSource(
        "src/app/api/admin/users/[id]/force-logout/route.ts",
        "admin.users.force-logout",
      ),
    );
    expect(route).toMatch(/\bdestroyAllSessions\s*\(/);
  });
});
