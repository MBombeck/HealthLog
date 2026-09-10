/**
 * Every idempotent route says so in the contract, and only those do.
 *
 * `withIdempotency` has wrapped writes since v1.5.x. `Idempotency-Key` appeared
 * in a dozen route comments and in no published schema, so an app generated
 * against `docs/api/openapi.yaml` could not tell that a retry was safe — which
 * is exactly what the iOS side asked for. Publishing it once is easy; keeping
 * it published as routes come and go is what this guard is for.
 *
 * Both directions matter, and for different reasons:
 *
 *   - A route that gains `withIdempotency` and forgets to publish it leaves the
 *     capability invisible, which is today's defect repeating itself.
 *   - A route that publishes the parameter and drops the wrapper is worse: the
 *     contract then promises a retry is safe when it is not, and a client that
 *     believes it writes twice.
 *
 * The wrapper is the source of truth here, not this file. Nothing is
 * hand-listed: the expected set is read out of the route tree on every run, so
 * the guard cannot fall behind the code it watches.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "@/lib/openapi/registry";

const API_ROOT = join(process.cwd(), "src", "app", "api");

/** Every `route.ts` under `src/app/api`, tests excluded. */
function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      found.push(...routeFiles(full));
      continue;
    }
    if (entry.name === "route.ts") found.push(full);
  }
  return found;
}

/** `src/app/api/medications/[id]/intake/route.ts` -> `/api/medications/{id}/intake` */
function toOpenApiPath(file: string): string {
  const rel = relative(API_ROOT, file).split(sep).slice(0, -1);
  const segments = rel.map((s) =>
    s.startsWith("[") && s.endsWith("]") ? `{${s.slice(1, -1)}}` : s,
  );
  return `/api/${segments.join("/")}`;
}

/**
 * Method-level, not path-level, and the difference is the whole point.
 *
 * `/api/measurements` exports GET, POST, PUT and DELETE, and only POST is
 * wrapped:
 *
 *     export const POST = apiHandler(withIdempotency<[NextRequest]>(postMeasurement));
 *     export const PUT  = apiHandler(putMeasurement);
 *
 * A path-level check would go green on that path the moment ANY operation
 * declared the header, and publishing it on PUT as well would promise a safe
 * retry the server does not honour. So the unit here is `POST /api/x`, and the
 * matcher requires the wrapper in the same assignment as the export.
 */
function idempotentOperationsFromSource(): Set<string> {
  const found = new Set<string>();
  // `export const POST = ...withIdempotency...` up to the end of that
  // statement. Non-greedy to the next top-level `export const`, so a wrapped
  // POST cannot lend its wrapper to the PUT declared below it.
  const pattern =
    /export\s+const\s+(POST|PUT|PATCH|DELETE)\s*=\s*([\s\S]*?)(?=\n(?:export\s+const|export\s+async\s+function|$))/g;
  for (const file of routeFiles(API_ROOT)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("withIdempotency")) continue;
    for (const match of source.matchAll(pattern)) {
      if (!/\bwithIdempotency\s*[(<]/.test(match[2])) continue;
      found.add(`${match[1].toLowerCase()} ${toOpenApiPath(file)}`);
    }
  }
  return found;
}

/** Operations in the emitted document that declare the `Idempotency-Key`. */
function idempotentOperationsFromContract(): Set<string> {
  const doc = buildOpenApiDocument() as {
    paths?: Record<string, Record<string, unknown>>;
  };
  const found = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      const parameters = (operation as { parameters?: unknown })?.parameters;
      if (!Array.isArray(parameters)) continue;
      const declares = parameters.some(
        (p) => (p as { name?: string })?.name === "Idempotency-Key",
      );
      if (declares) found.add(`${method.toLowerCase()} ${path}`);
    }
  }
  return found;
}

/**
 * Idempotent operations that cannot be published, because the PATH is not in
 * the document at all. A header cannot hang on a path that does not exist.
 *
 * One entry, and the list was four until the test below refused it. The first
 * draft claimed the whole `/api/medications` family was missing, on the
 * strength of a grep for path literals in `src/lib/openapi/routes/` that came
 * back empty. It came back empty because those paths are not written as
 * searchable literals there — the emitted document carries them, including
 * every one the iOS client actually argues about. Measure the artefact, not
 * the source that builds it.
 *
 * `/api/insights/feedback` left this list when the route joined the route
 * table, and the leg below is what made that a diff rather than a permanent
 * exemption: the moment the path appeared in the document, the entry claiming
 * it could not be published became false and the run went red. An exemption
 * nobody removes is how a gap becomes furniture.
 *
 * Listed rather than filtered silently, so the exclusion stays visible in the
 * file that would otherwise claim full coverage.
 */
const UNPUBLISHED_PATHS: Readonly<Record<string, string>> = {};

describe("idempotency — the contract matches the wrapper", () => {
  it("finds idempotent operations in the source tree at all", () => {
    // Without this the two comparisons below could both pass on empty sets,
    // which is the failure mode this whole file exists to prevent elsewhere.
    const fromSource = idempotentOperationsFromSource();
    expect(fromSource.size).toBeGreaterThan(20);
  });

  it("publishes the header on every route that wraps withIdempotency", () => {
    const fromSource = idempotentOperationsFromSource();
    const fromContract = idempotentOperationsFromContract();

    const unpublished = [...fromSource]
      .filter((p) => !fromContract.has(p))
      .filter((p) => !(p.split(" ")[1] in UNPUBLISHED_PATHS))
      .sort();

    expect(
      unpublished,
      `These routes accept an Idempotency-Key and do not say so in the ` +
        `contract, so a generated client cannot know a retry is safe. Add ` +
        `\`idempotencyKeyParameter\` to the write operation and ` +
        `\`...idempotentWrite()\` to its responses.`,
    ).toEqual([]);
  });

  it("keeps the unpublished list honest — every entry is still absent", () => {
    const doc = buildOpenApiDocument() as { paths?: Record<string, unknown> };
    const present = Object.keys(doc.paths ?? {});

    const nowPublished = Object.keys(UNPUBLISHED_PATHS)
      .filter((p) => present.includes(p))
      .sort();

    expect(
      nowPublished,
      `These paths are in the contract now, so their exemption above is stale. ` +
        `Delete the entry and add \`idempotencyKeyParameter\` to the operation ` +
        `— an exemption nobody removes is how a gap becomes permanent.`,
    ).toEqual([]);
  });

  it("does not promise idempotency on a route that dropped the wrapper", () => {
    const fromSource = idempotentOperationsFromSource();
    const fromContract = idempotentOperationsFromContract();

    const overclaimed = [...fromContract]
      .filter((p) => !fromSource.has(p))
      .sort();

    expect(
      overclaimed,
      `The contract offers an Idempotency-Key on these paths and no handler ` +
        `honours it. A client that trusts this writes twice on a retry — the ` +
        `more dangerous of the two directions.`,
    ).toEqual([]);
  });
});
