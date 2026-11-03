/**
 * The runtime packages the image installs from apk are pinned, and the
 * PostgreSQL client moves with the bundled database.
 *
 * The runner installs Node and the PostgreSQL client from the Wolfi
 * repository. Unpinned, a rebuild of the same commit could ship another
 * Node or another pg_dump than the one the release was checked with. No
 * updater reads an apk pin; the image scan is what flags a pinned package
 * once Wolfi publishes a fix (the Dockerfile comment explains the bump), so
 * this file only holds the pins' shape and their agreement with the rest of
 * the repository.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");
const COMPOSE = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");

function runner(): string {
  const start = DOCKERFILE.search(/^FROM .* AS runner$/m);
  expect(start, "the Dockerfile has a runner stage").toBeGreaterThan(0);
  return DOCKERFILE.slice(start);
}

function apkAdds(): string[] {
  return [...runner().matchAll(/apk add --no-cache ([^&\n\\]+)/g)].flatMap(
    (m) => m[1]!.trim().split(/\s+/),
  );
}

describe("runtime package pins", () => {
  it("pins nodejs-22 to one exact Node 22 package version", () => {
    const pins = apkAdds().filter((p) => p.startsWith("nodejs"));
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatch(/^nodejs-22=22\.\d+\.\d+-r\d+$/);
  });

  it("pins postgresql-18-client to the bundled database's minor", () => {
    const pins = apkAdds().filter((p) => p.startsWith("postgresql"));
    expect(pins).toHaveLength(1);
    const client = /^postgresql-18-client=(18\.\d+)-r\d+$/.exec(pins[0]!);
    expect(client, `an exact pin, not ${pins[0]}`).not.toBeNull();
    const db = /^\s*image:\s*postgres:(\d+\.\d+)-alpine$/m.exec(COMPOSE);
    expect(db, "the compose file pins the database").not.toBeNull();
    // One decision: a database minor bump moves the client with it.
    expect(client![1]).toBe(db![1]);
  });

  it("leaves no other package floating except tzdata and the build-only npm", () => {
    const unpinned = apkAdds().filter((p) => !p.includes("="));
    expect(new Set(unpinned)).toEqual(new Set(["tzdata", "npm"]));
  });
});
