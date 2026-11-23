/**
 * Every path that ends a native sign-in also ends the device's pushes.
 *
 * A refresh token names the device it was issued on (`RefreshToken.deviceId`).
 * When the last live one of a device is revoked, the device row has to lose
 * its APNs token, push key, relay binding and Live Activity state
 * (`src/lib/devices/signed-out-push.ts`), or the reminders of an account the
 * phone has left keep reaching its lock screen. The rule lives at the
 * revocation, so a new revocation path that forgets it is the regression.
 *
 * This guard finds every write that revokes refresh tokens (a Prisma
 * `refreshToken.updateMany` whose `data` sets `revokedAt`, or a raw
 * `UPDATE refresh_tokens … revoked_at`) and holds the set: each file must be
 * listed below with its count, and each listed file must call the strip, or
 * name the callers that do. A new writer, or one more write in a listed file,
 * fails until it is looked at here.
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
const HOOK = /\b(afterRefreshRevocation|stripSignedOutDevicePush)\s*\(/;

/**
 * The revocation writers. `hookedIn` lists the files that must call the strip
 * for this file's writes: the file itself, or, for a leaf that only builds
 * the statements, the callers that run them.
 */
const REVOCATION_WRITERS: Record<
  string,
  { writes: number; hookedIn: string[]; why: string }
> = {
  "lib/auth/refresh-token.ts": {
    writes: 5,
    hookedIn: ["lib/auth/refresh-token.ts"],
    why: "reuse detection, the rotation race's retired pair (its winner is live), the Bearer logout, the handoff replay and the refresh-token logout",
  },
  "lib/auth/session.ts": {
    writes: 1,
    hookedIn: ["lib/auth/session.ts"],
    why: "sign out everywhere else, in its transaction",
  },
  "lib/auth/credential-revocations.ts": {
    writes: 1,
    hookedIn: ["lib/auth/session.ts", "lib/account-deletion/lifecycle.ts"],
    why: "a leaf list of statements: destroyAllSessions and the deletion lock run it, and both strip after it",
  },
  "lib/devices/revoke.ts": {
    writes: 1,
    hookedIn: [],
    why: "deletes the device row itself and queues its relay unbind in the same transaction",
  },
};

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

/** The text between the `(` at `open` and its matching `)`. */
function argsFrom(code: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  let i = open;
  for (; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  return code.slice(open + 1, i);
}

/** How many refresh-token revocations a source text writes. */
function countRevocations(source: string): number {
  const code = stripComments(source);
  let count = 0;
  const call = /refreshToken\s*\.\s*(updateMany|update)\s*\(/g;
  for (let m = call.exec(code); m; m = call.exec(code)) {
    const args = argsFrom(code, m.index + m[0].length - 1);
    if (/\bdata\s*:\s*\{[^}]*\brevokedAt\b/.test(args)) count += 1;
  }
  const raw =
    /UPDATE\s+"?refresh_tokens"?\s+(AS\s+\w+\s+)?SET\b[^;`]*revoked_at/gi;
  count += code.match(raw)?.length ?? 0;
  return count;
}

describe("refresh-token revocations strip the signed-out device's pushes", () => {
  const found = new Map<string, number>();
  for (const rel of sourceFiles()) {
    const n = countRevocations(readSourceText(join(SRC, rel)));
    if (n > 0) found.set(rel, n);
  }

  it("finds the writers at all (a matcher that matches nothing is no guard)", () => {
    expect(found.size).toBeGreaterThanOrEqual(4);
    expect(
      countRevocations(
        "tx.refreshToken.updateMany({ where: { id }, data: { revokedAt: now } })",
      ),
    ).toBe(1);
    expect(
      countRevocations(
        "prisma.refreshToken.updateMany({ where: { revokedAt: null }, data: { usedAt: now } })",
      ),
    ).toBe(0);
    expect(
      countRevocations("UPDATE refresh_tokens SET revoked_at = now()"),
    ).toBe(1);
  });

  it("holds exactly the listed writers, with their counts", () => {
    expect(Object.fromEntries(found)).toEqual(
      Object.fromEntries(
        Object.entries(REVOCATION_WRITERS).map(([f, w]) => [f, w.writes]),
      ),
    );
  });

  it.each(Object.entries(REVOCATION_WRITERS))(
    "%s: the strip runs after its writes",
    (_file, writer) => {
      for (const caller of writer.hookedIn) {
        expect(
          HOOK.test(stripComments(readSourceText(join(SRC, caller)))),
          `${caller} must call afterRefreshRevocation or stripSignedOutDevicePush`,
        ).toBe(true);
      }
    },
  );

  it("every runner of the leaf statement list strips after it", () => {
    const runners = sourceFiles().filter(
      (rel) =>
        rel !== "lib/auth/credential-revocations.ts" &&
        /\bcredentialRevocations\s*\(/.test(
          stripComments(readSourceText(join(SRC, rel))),
        ),
    );
    expect(runners.sort()).toEqual(
      [
        ...REVOCATION_WRITERS["lib/auth/credential-revocations.ts"].hookedIn,
      ].sort(),
    );
  });

  it("the device delete queues the relay unbind with the row's removal", () => {
    const code = stripComments(
      readSource("src/lib/devices/revoke.ts", [/revokeDeviceCascade/]),
    );
    // Through the one delete path, which queues the unbind with the row.
    expect(code).toMatch(/\bdeviceDeleteWrites\s*\(/);
    expect(code).toMatch(/deviceId:\s*device\.token/);
  });
});
