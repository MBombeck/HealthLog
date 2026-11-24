/**
 * Every emergency-card link query says which link it means.
 *
 * Until v1.50 a record had at most one live link, so a query on
 * `emergencyCardLink` by `userId` meant "the" link. A wallet pass now carries
 * a link of its own (`purpose: "WALLET"`), so the same query would find the
 * pass's link too: "Revoke link" on the card page would end the pass, and the
 * printed card's status could show the pass's counters.
 *
 * So every `<client>.emergencyCardLink.<op>(` call under `src/` names
 * `purpose` in its argument, or is listed below with the reason it means
 * every purpose (or reaches one row by a key that already decides it). A new
 * call that does neither fails. The match is whitespace-tolerant, the walk
 * and the match count have floors, and a listed call that is gone fails too,
 * so the list cannot go stale.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const CALL =
  /\b\w+\s*\.\s*emergencyCardLink\s*\.\s*(findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|count|aggregate|groupBy|create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g;

/** `file op` -> why the call needs no purpose. */
const EVERY_PURPOSE: Record<string, string> = {
  "lib/emergency-card/serve.ts findUnique":
    "The `/e/` read looks a link up by its token hash; both purposes are `/e/` links and the hash names one row.",
  "lib/emergency-card/serve.ts update":
    "Bumps the counters of the row the token lookup found, by id.",
  "lib/auth/credential-revocations.ts updateMany":
    "A password change or an admin reset ends every standing door to the record, the printed card's link and a wallet pass's alike.",
  "lib/managed-profiles/lifecycle.ts updateMany":
    "A handover ends every link a guardian made for the profile, whatever it is for.",
  "lib/onboarding/checklist-extras-load.ts count":
    "The checklist asks whether the card is carried at all; a printed card's link and a wallet pass both count.",
};

/** The argument text of the call that opens at `open` (the `(`). */
function argumentOf(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced call");
}

function calls(): Array<{ id: string; names: boolean }> {
  const files = walkSourceFiles(SRC, { floor: 3000 }).filter(
    (p) =>
      !p.startsWith("generated/") &&
      !p.includes("__tests__/") &&
      !/\.test\.tsx?$/.test(p),
  );
  const found: Array<{ id: string; names: boolean }> = [];
  for (const file of files) {
    const source = stripComments(readSourceText(join(SRC, file)));
    for (const m of source.matchAll(CALL)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      found.push({
        id: `${file} ${m[1]}`,
        // A value, not a `select` flag (`purpose: true`).
        names: /\bpurpose\s*:\s*(?!true\b|false\b)\S/.test(
          argumentOf(source, open),
        ),
      });
    }
  }
  return found;
}

describe("emergency-card link queries name their purpose", () => {
  const found = requireFloor("emergencyCardLink calls", calls(), 9);

  it("every call names `purpose` or is listed with a reason", () => {
    const unlisted = found
      .filter((c) => !c.names && !(c.id in EVERY_PURPOSE))
      .map((c) => c.id);
    expect(unlisted).toEqual([]);
  });

  it("every listed call still exists and still omits the purpose", () => {
    const omitting = new Set(found.filter((c) => !c.names).map((c) => c.id));
    const stale = Object.keys(EVERY_PURPOSE).filter((id) => !omitting.has(id));
    expect(stale).toEqual([]);
  });

  it("the purpose-scoped calls are the printed card's own", () => {
    const named = found.filter((c) => c.names).map((c) => c.id);
    expect(named).toEqual(
      expect.arrayContaining([
        "lib/emergency-card/manage.ts findFirst",
        "app/api/emergency-card/link/route.ts create",
        "app/api/emergency-card/link/route.ts updateMany",
        "app/api/emergency-card/wallet/route.ts findFirst",
      ]),
    );
  });
});
