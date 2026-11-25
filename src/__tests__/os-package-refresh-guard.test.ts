/**
 * Every Dockerfile stage that fetches OS packages re-fetches them on every
 * published build.
 *
 * The runner's `apt-get update; apt-get upgrade` exists to take Debian
 * security fixes the pinned base digest has not absorbed. The publishing
 * workflows build with a layer cache, and the RUN's text never changes, so
 * without a changing input BuildKit serves the layer from the first build
 * and the upgrade never runs again: the image scan kept reporting glibc and
 * Kerberos findings whose fixes were already in the archive. A build-arg
 * declared before the apt RUN and fed a per-run value from each publishing
 * workflow invalidates that layer. This file holds both ends: the ARG in
 * the Dockerfile and the value in the workflows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");
const ARG = "OS_PACKAGES_REFRESH";

/** Each stage's instructions, comment lines dropped. */
function stages(): { name: string; body: string }[] {
  const lines = DOCKERFILE.split("\n").filter(
    (line) => !line.trimStart().startsWith("#"),
  );
  const out: { name: string; body: string }[] = [];
  for (const line of lines) {
    const from = /^FROM \S+ AS (\S+)$/.exec(line);
    if (from) out.push({ name: from[1]!, body: "" });
    else if (out.length > 0) out[out.length - 1]!.body += `${line}\n`;
  }
  return out;
}

const APT_FETCH = /apt-get\s+(?:-\S+\s+)*(?:update|upgrade|dist-upgrade)\b/;

describe("OS package refresh", () => {
  it("finds the stages and at least one apt fetch", () => {
    const all = stages();
    expect(all.length).toBe(DOCKERFILE.match(/^FROM /gm)?.length);
    // A matcher that finds nothing proves nothing.
    expect(all.filter((s) => APT_FETCH.test(s.body)).length).toBeGreaterThan(0);
  });

  it("declares the refresh build-arg before every apt fetch, in its stage", () => {
    for (const { name, body } of stages()) {
      const fetch = body.search(APT_FETCH);
      if (fetch < 0) continue;
      const decl = body.search(new RegExp(`^ARG ${ARG}(?:=|\\s*$)`, "m"));
      expect(decl, `${name} declares ARG ${ARG}`).toBeGreaterThanOrEqual(0);
      expect(decl, `${name} declares ARG ${ARG} before apt`).toBeLessThan(
        fetch,
      );
      // Nothing but the apt RUN itself between the declaration and the
      // fetch, so no other instruction can be cached in front of it.
      const between = body.slice(decl, fetch).split("\n").slice(1);
      const instructions = between.filter((l) => /^[A-Z]+\s/.test(l));
      expect(
        instructions.map((l) => l.split(/\s/)[0]),
        `${name}: only the apt RUN follows ARG ${ARG}`,
      ).toEqual(["RUN"]);
    }
  });

  it.each([
    ".github/workflows/docker-publish.yml",
    ".github/workflows/edge-image.yml",
  ])("%s passes a per-run refresh value", (file) => {
    const workflow = readFileSync(join(ROOT, file), "utf8");
    const builds = workflow.match(/uses: docker\/build-push-action@/g) ?? [];
    expect(builds.length).toBeGreaterThan(0);
    const values = [
      ...workflow.matchAll(new RegExp(`^\\s+${ARG}=(.+)$`, "gm")),
    ].map((m) => m[1]!.trim());
    expect(values).toHaveLength(builds.length);
    for (const value of values) {
      expect(value).toContain("${{ github.run_id }}");
      expect(value).toContain("${{ github.run_attempt }}");
    }
  });
});
