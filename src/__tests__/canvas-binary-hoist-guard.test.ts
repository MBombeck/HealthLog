/**
 * Structural guard: the runtime image puts the @napi-rs/canvas native binary
 * of the version the app pins next to that version's loader.
 *
 * ## The failure this freezes (GitHub #1124)
 *
 * The pnpm store holds two canvas versions: the one in package.json and an
 * older one that pdf-parse's own pdfjs-dist pulls in. The runner stage picked
 * the musl binary with `find | head -1`, got the old one, and copied it into
 * the new loader's directory, where the loader looks first. PDF rendering
 * still worked, so nothing looked wrong; `loadImage` called an
 * `Image.decode` the old binary lacks, and every preview thumbnail failed
 * with "image.decode is not a function" on both architectures.
 *
 * ## What it proves and what it does not
 *
 * The builder records the resolved canvas version, the runner hoists by that
 * name, and the build stops when the copied binary's package is a different
 * version. Whether the binary loads is proved when the image runs; this file
 * reads the Dockerfile only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DOCKERFILE = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");

function stage(name: string): string {
  const start = DOCKERFILE.search(new RegExp(`^FROM .* AS ${name}$`, "m"));
  expect(start, `the Dockerfile has a ${name} stage`).toBeGreaterThan(0);
  const next = DOCKERFILE.slice(start + 1).search(/^FROM /m);
  return next < 0
    ? DOCKERFILE.slice(start)
    : DOCKERFILE.slice(start, start + 1 + next);
}

describe("canvas binary hoist", () => {
  it("records the resolved canvas version in the builder", () => {
    expect(stage("builder")).toMatch(
      /require\('\/app\/node_modules\/@napi-rs\/canvas\/package\.json'\)\.version"[\s\\]*>\s*\/app\/\.canvas-version/,
    );
  });

  it("hoists the loader and the musl binary of that version only", () => {
    const runner = stage("runner");
    expect(runner).toContain(
      "COPY --from=builder /app/.canvas-version /tmp/.canvas-version",
    );
    expect(runner).toContain(
      'CANVAS_DIR="/app/node_modules/.pnpm/@napi-rs+canvas@${CANVAS_VERSION}/',
    );
    expect(runner).toContain("canvas-linux-*-musl@${CANVAS_VERSION}/");
    // A version-blind pick is the defect: any `canvas…@*` glob decides by
    // readdir order which of the store's copies wins.
    expect(runner).not.toMatch(/@napi-rs\+canvas[^"'\s]*@\*/);
  });

  it("fails the build when the copied binary is another version", () => {
    const runner = stage("runner");
    expect(runner).toMatch(
      /\[ "\$BIN_VERSION" = "\$CANVAS_VERSION" \] \|\| \{[^}]*exit 1; \}/,
    );
  });
});
