/**
 * Every published GET, called for real and read against the schema that
 * publishes it.
 *
 * `openapi-response-shape.test.ts` asked this question of two responses, the
 * two that had already been caught drifting. Everything else in the gate
 * proves one end at a time: `openapi:check` holds the YAML to the registry,
 * the route-coverage guard holds the registry to the route files, and neither
 * ever looks at a body. A schema that disagrees with what its handler sends
 * passes all of them, and the native client — which decodes against the
 * contract, not against the handler — is the first thing to notice.
 *
 * So the operation list here is derived from the registry, not written down:
 * every path with a `get` whose 2xx response publishes an `application/json`
 * schema. Each is called through its route module's own `GET` export as one
 * seeded account, and the body is parsed with the published schema. Two
 * failures count:
 *
 *   - the parse fails: a required field is missing or has the wrong type;
 *   - the parse drops something: Zod strips undeclared keys rather than
 *     refusing them, so the parsed value is compared back to the raw body and
 *     any key that did not survive is a field the server sends and the
 *     contract does not declare. Loose objects (`meta` on the error envelope,
 *     a few deliberately open maps) keep unknown keys by design, so this half
 *     does not reach inside them.
 *
 * An operation that cannot be called meaningfully in-process sits in
 * {@link NOT_CALLED} with its reason. The list is the exception, not the
 * selection: a new GET is checked the day it is registered, and the floor at
 * the bottom fails if the checked set ever shrinks to something that proves
 * little.
 */
import { NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { assertRecordContext, cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { seedContractAccount, type ContractFixture } from "./contract-seed";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

// The health route reports the worker it shares the process with. There is
// none in a test process, which is the published 503; a running one is the
// 200 the schema describes.
vi.mock("@/lib/jobs/worker-status", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jobs/worker-status")>();
  return {
    ...actual,
    getWorkerStatus: () => ({
      ...actual.getWorkerStatus(),
      running: true,
      lastHeartbeat: new Date().toISOString(),
    }),
  };
});

// No request leaves the process. An operation that needs the network to
// answer belongs in NOT_CALLED with that reason; one that merely tries and
// copes with the failure is checked on the path it takes when it cannot.
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: vi.fn(async () => {
      throw new actual.SafeFetchError("offline in the contract run", "network");
    }),
  };
});

/**
 * Operations that are published and not called, each with the reason.
 *
 * A reason has to be about the operation, not about the fixture: "needs a
 * seeded X" is a fixture to write, not an exception to take.
 */
const NOT_CALLED: Record<string, string> = {
  "/api/insights/generate":
    "Generates a briefing with the account's AI provider on the request path; with no provider it answers the published 422, and with one it would call the model.",
  "/api/environment/geocode":
    "A pass-through to the operator's geocoding service; the body is the service's answer.",
  "/api/dawarich/places":
    "Reads places from the account's own Dawarich instance; unconnected it answers the published 409.",
  "/api/documents/sources/{system}/tags":
    "Reads tags from the operator's document archive; with none configured it answers the published 404.",
  "/api/documents/sources/{system}/search":
    "Searches the operator's document archive; with none configured it answers the published 404.",
};

/** The least number of operations that must actually be called and parsed. */
const CHECKED_FLOOR = 235;

/**
 * Operations whose every list may come back empty here, with the reason. An
 * empty list parses against any item schema, so every other operation must
 * answer at least once with a list that has a row in it; the seed
 * (`contract-seed.ts`) writes one for each. As for `NOT_CALLED`, a reason is
 * about the operation: a list a fixture could fill is a row to seed.
 */
const EMPTY_ALLOWED: Record<string, string> = {
  "/api/auth/me/mfa":
    "The list is the account's security keys, and an enrolled second factor turns the export and backup reads this run also calls into a re-proof a seeded session cannot give.",
  "/api/auth/passkeys":
    "The same: a passkey on the account puts the export and backup reads behind a re-proof.",
  "/api/coach/about-me/questions":
    "The questions are written by the account's AI provider; the run has none.",
  "/api/insights/medication-compliance-status":
    "The per-medication summaries are written by the account's AI provider; with none the published answer is the empty list beside `hasProvider: false`.",
  "/api/insights/chat/{id}/messages/{messageId}/results":
    "Result tables are stored by a model turn that called tools, in its own sealed format; the run has no provider.",
  "/api/cycle/insights":
    "A phase row only survives a false-discovery-rate test over many cycles of readings, which no handful of rows passes.",
  "/api/insights/health-status":
    "A deviation or shift is reported only once a reading leaves the account's own long-run baseline, which needs months of history.",
  "/api/insights/glp1-timeline":
    "Entries exist only for a GLP-1 medication, whose dose phases would change what the main medication's reads answer.",
  "/api/documents/sources":
    "Lists connections to the operator's document archive, which is environment configuration; the run configures none.",
  "/api/environment/travel/suggestions":
    "Suggestions come from the account's location history in an external Dawarich instance the run does not reach.",
  "/api/mcp/connections":
    "A connection is minted only by the OAuth authorization flow of a registered agent client.",
};

/** The least number of operations that answer with a list that has a row. */
const FILLED_FLOOR = 228;

/**
 * The queries each operation is called with. An operation with a required
 * parameter needs an entry; an operation whose optional parameters select a
 * different body shape gets one variant per shape, because each is a separate
 * promise the schema makes.
 */
function queriesFor(
  path: string,
  fx: ContractFixture,
): Array<Record<string, string>> {
  const from = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const to = new Date().toISOString();
  const day = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  switch (path) {
    case "/api/cycle/day-logs":
      return [{ date: day(3) }];
    case "/api/measurements":
      return [{}, { groupBy: "day", type: "WEIGHT" }, { dayKey: day(2) }];
    case "/api/measurements/series-batch":
      return [{ types: "WEIGHT,PULSE,ACTIVITY_STEPS", from, to }];
    case "/api/measurements/series":
      return [
        { kind: "weight" },
        { kind: "bloodPressure" },
        { kind: "sleep" },
        { kind: "glucose" },
      ];
    case "/api/medications/intake":
      return [{ scope: "today" }, { scope: "compliance" }];
    case "/api/insights/coach-read":
      return [{ metric: "WEIGHT" }];
    case "/api/insights/narrative":
      return [{ period: "week" }];
    case "/api/analytics/range":
      return [{ type: "WEIGHT", range: "30d" }];
    case "/api/insights/metric-status":
      return [{ metric: "RESTING_HEART_RATE" }];
    case "/api/insights/biomarker-assessment":
      return [{ biomarkerId: fx.id("biomarker") }];
    case "/api/insights/derived":
      return [
        { metric: "BMI" },
        { metric: "VITALS_BASELINE", type: "RESTING_HEART_RATE" },
        { metric: "HEALTH_SCORE" },
      ];
    case "/api/insights/derived/batch":
      return [{ metrics: "BMI,HRV_BALANCE,VITALS_BASELINE:PULSE" }];
    case "/api/insights/score-history":
      return [{ score: "HEALTH_SCORE", days: "30" }];
    case "/api/mood/linked-context":
      return [{ date: day(2) }];
    case "/api/encounters/suggest":
    case "/api/vaccinations/suggest":
      return [{ anchor: new Date(Date.now() - 30 * 86_400_000).toISOString() }];
    case "/api/nutrients/daily":
      return [{ nutrient: "vitamin_d" }];
    case "/api/day/index":
      return [{ from: day(14), to: day(0) }];
    case "/api/measurements/provenance":
      return [
        { type: "ACTIVITY_STEPS", date: day(2) },
        { type: "WEIGHT", date: day(2) },
      ];
    case "/api/measurements/provenance/compare":
      return [
        { type: "ACTIVITY_STEPS", from: day(14), to: day(0) },
        {
          type: "ACTIVITY_STEPS",
          from: day(14),
          to: day(0),
          a: "APPLE_HEALTH",
          b: "MANUAL",
        },
      ];
    case "/api/documents/inbound/source":
      return [{ sourceSystem: "PAPERLESS", sourceId: "4711" }];
    case "/api/documents/sources/{system}/search":
      return [{ q: "letter" }];
    default:
      return [{}];
  }
}

/**
 * Operations served to a guardian inside a managed profile rather than to an
 * account on its own record. They are called with the session switched into
 * the seeded managed profile.
 */
const AS_GUARDIAN = new Set([
  "/api/record-settings",
  "/api/record-settings/integrations",
  "/api/record-settings/{family}",
]);

interface PublishedGet {
  path: string;
  statuses: Map<number, z.ZodType>;
  requiredQuery: string[];
}

type Operation = {
  responses?: Record<
    string,
    { content?: Record<string, { schema?: z.ZodType }> }
  >;
  requestParams?: { query?: z.ZodType };
};

function requiredQueryKeys(schema: z.ZodType | undefined): string[] {
  if (!schema) return [];
  const shape = (schema as unknown as { shape?: Record<string, z.ZodType> })
    .shape;
  if (!shape) return [];
  return Object.entries(shape)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([key]) => key);
}

async function publishedGets(): Promise<PublishedGet[]> {
  const { openApiPaths } = await import("@/lib/openapi/routes");
  const out: PublishedGet[] = [];
  for (const [path, item] of Object.entries(
    openApiPaths as Record<string, { get?: Operation }>,
  )) {
    const op = item.get;
    if (!op?.responses) continue;
    const statuses = new Map<number, z.ZodType>();
    for (const [code, response] of Object.entries(op.responses)) {
      const status = Number(code);
      if (!(status >= 200 && status < 300)) continue;
      const schema = response.content?.["application/json"]?.schema;
      if (schema) statuses.set(status, schema);
    }
    if (statuses.size === 0) continue;
    out.push({
      path,
      statuses,
      requiredQuery: requiredQueryKeys(op.requestParams?.query),
    });
  }
  return out;
}

function routeFile(path: string): string {
  return join(
    process.cwd(),
    "src/app",
    path.replace(/\{([^}]+)\}/g, "[$1]"),
    "route.ts",
  );
}

/**
 * Every place the parsed value differs from the raw body: a key the parse
 * dropped (undeclared on the wire) or a value it rewrote.
 */
function strippedOrRewritten(raw: unknown, parsed: unknown, at = ""): string[] {
  if (raw === null || typeof raw !== "object") {
    return Object.is(raw, parsed) ? [] : [`${at || "."}: rewritten`];
  }
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed)) return [`${at || "."}: rewritten`];
    const out: string[] = [];
    // One element of each array is enough to name the field; reporting the
    // same undeclared key a thousand times buries the next finding.
    const seen = new Set<string>();
    raw.forEach((item, i) => {
      for (const finding of strippedOrRewritten(item, parsed[i], `${at}[]`)) {
        if (!seen.has(finding)) {
          seen.add(finding);
          out.push(finding);
        }
      }
    });
    return out;
  }
  if (parsed === null || typeof parsed !== "object") {
    return [`${at || "."}: rewritten`];
  }
  const out: string[] = [];
  const p = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(key in p)) {
      out.push(`${at}.${key}: undeclared`);
      continue;
    }
    out.push(...strippedOrRewritten(value, p[key], `${at}.${key}`));
  }
  return out;
}

interface Finding {
  path: string;
  problem: string;
}

let fixture: ContractFixture;

beforeAll(async () => {
  // Web Push configured, so the VAPID key route answers with a key.
  const { generateVAPIDKeys } = await import("web-push");
  const keys = generateVAPIDKeys();
  vi.stubEnv("VAPID_PUBLIC_KEY", keys.publicKey);
  vi.stubEnv("VAPID_PRIVATE_KEY", keys.privateKey);
  vi.stubEnv("VAPID_SUBJECT", "mailto:operator@example.test");

  const prisma = getPrismaClient();
  const { setGlobalBoss } = await import("@/lib/jobs/boss-instance");
  // A producer is present, as in a running web process; nothing is sent.
  setGlobalBoss({ send: async () => null } as never);
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  fixture = await seedContractAccount(prisma);
}, 300_000);

/** Put the cookie (and the record assertion) in place for one call. */
function enter(path: string): void {
  headerJar.clear();
  if (AS_GUARDIAN.has(path)) {
    cookieJar.set("healthlog_session", fixture.guardianSessionId);
    assertRecordContext(fixture.guardianRecordEpoch, fixture.managedProfileId);
  } else {
    cookieJar.set("healthlog_session", fixture.sessionId);
  }
}

/** Whether a body carries arrays and every one of them is empty. */
function onlyEmptyArrays(value: unknown): boolean {
  let arrays = 0;
  let filled = 0;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      arrays += 1;
      if (v.length > 0) filled += 1;
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return arrays > 0 && filled === 0;
}

const emptyBodies: string[] = [];
/** Operations that answered at least once with a row in a list (or no list). */
const filled = new Set<string>();

/** Call one operation once and report what disagrees with its schema. */
async function check(
  op: PublishedGet,
  query: Record<string, string>,
): Promise<{ called: boolean; findings: string[] }> {
  const params = fixture.pathParams(op.path);
  if (params === null) {
    return { called: false, findings: ["no fixture for path params"] };
  }
  const missing = op.requiredQuery.filter((key) => !(key in query));
  if (missing.length > 0) {
    return {
      called: false,
      findings: [`no fixture for required query ${missing.join(", ")}`],
    };
  }
  let concrete = op.path;
  for (const [name, value] of Object.entries(params)) {
    concrete = concrete.replace(`{${name}}`, encodeURIComponent(value));
  }
  const url = new URL(`http://localhost${concrete}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const mod = (await import(/* @vite-ignore */ routeFile(op.path))) as {
    GET?: (req: NextRequest, ctx: unknown) => Promise<Response>;
  };
  if (!mod.GET) return { called: false, findings: ["route exports no GET"] };

  enter(op.path);
  let res: Response;
  try {
    res = await mod.GET(new NextRequest(url), {
      params: Promise.resolve(params),
    });
  } catch (error) {
    return { called: false, findings: [`threw: ${(error as Error).message}`] };
  }

  const schema = op.statuses.get(res.status);
  if (!schema) {
    const text = await res.text();
    return {
      called: false,
      findings: [
        `status ${res.status} is not a published 2xx: ${text.slice(0, 300)}`,
      ],
    };
  }

  const body: unknown = await res.json();
  if (process.env.CONTRACT_DUMP?.split(",").includes(op.path)) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      `${process.env.CONTRACT_REPORT}.bodies`,
      `${op.path}\n${JSON.stringify(body, null, 1).slice(0, 20000)}\n\n`,
    );
  }
  if (onlyEmptyArrays(body)) emptyBodies.push(op.path);
  else filled.add(op.path);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      called: true,
      findings: parsed.error.issues
        .slice(0, 8)
        .map(
          (issue) =>
            `${issue.path.join(".") || "."}: ${issue.code} ${issue.message}`,
        ),
    };
  }
  return { called: true, findings: strippedOrRewritten(body, parsed.data) };
}

describe("every published GET answers what its schema says", () => {
  it("parses each response against the registered schema and drops nothing", async () => {
    const operations = await publishedGets();
    if (process.env.CONTRACT_REPORT) {
      const { rmSync } = await import("node:fs");
      rmSync(process.env.CONTRACT_REPORT, { force: true });
    }
    const findings: Finding[] = fixture.seedFailures.map((problem) => ({
      path: "(seed)",
      problem,
    }));
    let checked = 0;

    for (const op of operations) {
      if (op.path in NOT_CALLED) continue;
      if (!existsSync(routeFile(op.path))) {
        findings.push({ path: op.path, problem: "no route file" });
        continue;
      }
      let calledOnce = false;
      for (const query of queriesFor(op.path, fixture)) {
        const label = Object.keys(query).length
          ? `${op.path}?${new URLSearchParams(query).toString()}`
          : op.path;
        const result = await check(op, query);
        calledOnce ||= result.called;
        for (const problem of result.findings) {
          findings.push({ path: label, problem });
        }
      }
      if (calledOnce) checked += 1;
    }

    if (process.env.CONTRACT_REPORT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        process.env.CONTRACT_REPORT,
        JSON.stringify({ checked, findings, emptyBodies }, null, 2),
      );
    }

    expect(findings).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(CHECKED_FLOOR);

    // Every list a schema promises is read with a row in it at least once,
    // apart from the reasoned exceptions; an exception that now has a row
    // is stale and goes.
    const onlyEmpty = [...new Set(emptyBodies)]
      .filter((path) => !filled.has(path))
      .sort();
    expect(onlyEmpty).toEqual(Object.keys(EMPTY_ALLOWED).sort());
    expect(filled.size).toBeGreaterThanOrEqual(FILLED_FLOOR);
  }, 600_000);

  it("leaves no exception that the run could have called", async () => {
    const published = new Set((await publishedGets()).map((op) => op.path));
    // An exception for an operation that is no longer published is a stale
    // entry that would quietly excuse its successor under the same path.
    expect(
      Object.keys(NOT_CALLED).filter((path) => !published.has(path)),
    ).toEqual([]);
  });
});
