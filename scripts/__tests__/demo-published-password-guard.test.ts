import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The demo password is published in the README so anyone can sign in to
 * demo.healthlog.dev. Its Argon2id hash lives in two places that must agree:
 *
 *   - scripts/seed-demo.ts          writes it when a demo tenant is seeded
 *   - scripts/migrate-demo-account.sh overwrites it after a migration load
 *
 * Public issue #805: the migration used to carry the SOURCE account's hash
 * across instead, so once the operator rotated their own demo password the
 * credentials the README advertises stopped working, and nothing noticed until
 * a visitor filed a bug. These assertions make the two copies move together.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const SEED = join(REPO_ROOT, "scripts", "seed-demo.ts");
const MIGRATE = join(REPO_ROOT, "scripts", "migrate-demo-account.sh");

/** Every Argon2id hash literal in a file, in source order. */
function argon2Hashes(path: string): string[] {
  const source = readFileSync(path, "utf8");
  return source.match(/\$argon2id\$[^"'\s]+/g) ?? [];
}

describe("published demo password", () => {
  it("is the same hash in the seed script and the demo migration", () => {
    const seeded = argon2Hashes(SEED);
    const migrated = argon2Hashes(MIGRATE);

    // An empty match set would make every assertion below vacuously true —
    // the failure mode this repo keeps rediscovering. Demand a hit first.
    expect(seeded.length).toBeGreaterThan(0);
    expect(migrated.length).toBeGreaterThan(0);

    // Each file states the hash exactly once, so a stray second copy (the
    // thing that lets the two drift again) is a failure in its own right.
    expect(new Set(seeded).size).toBe(1);
    expect(new Set(migrated).size).toBe(1);

    expect(migrated[0]).toBe(seeded[0]);
  });

  it("is written by the migration rather than carried from the source", () => {
    const script = readFileSync(MIGRATE, "utf8");

    // The overwrite must exist...
    expect(script).toMatch(
      /UPDATE users SET password_hash = '\$\{?PUBLIC_DEMO_PASSWORD_HASH\}?'/,
    );

    // ...and it must be proven, not merely attempted. Without the check a
    // mangled hash would reach a visitor's login screen instead of the script.
    expect(script).toContain(
      "ABORT/FAIL: demo password_hash on the target is not the published literal",
    );
  });

  it("keeps the overwrite off the ssh command line", () => {
    const script = readFileSync(MIGRATE, "utf8");

    // The hash carries '$argon2id', '$v', '$m', '$t', '$p'. Interpolated into
    // a double-quoted remote command those expand to empty strings and the
    // stored hash matches nothing. It has to travel on stdin.
    const sshWithHashInline = new RegExp(
      String.raw`ssh\s+"\$DST_SSH"\s+"[^"]*PUBLIC_DEMO_PASSWORD_HASH`,
    );
    expect(script).not.toMatch(sshWithHashInline);
  });
});
