/**
 * Structural guard on the places a model is actually called.
 *
 * A capability is only as good as the last check before the wire. A job
 * enqueued before an operator flipped a switch, or before the person withdrew
 * consent or turned AI analysis off, must still stop there. So every file that
 * hands a prompt to a provider (`.generateCompletion(`, the chain runners) is
 * named here with the reason its call is admitted, and the ones that ARE a
 * chokepoint must re-check a capability in the same file.
 *
 * Mirrors `ai-consent-enforcement-guard.test.ts` in shape and in its limits: it
 * proves a reference exists, not that it sits on every branch or before the
 * call. The integration suite with a provider spy
 * (`tests/integration/ai-optional-jobs.test.ts`) is what proves behaviour.
 * A future egress helper under a new name would slip the matcher; a reviewer
 * adding one should add it here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DOCUMENT_AI_RUN_KINDS } from "@/lib/documents/ai-runs/types";
import type { runStatusCompletion } from "@/lib/insights/status-provider";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** A provider call: a client's completion (plain or streamed), or a chain runner. */
const EGRESS_CALL =
  /\.generateCompletion(?:Stream)?\s*\(|\brunRawCompletionWithFallback\s*\(|\brunWithFallback\s*\(/;

/**
 * A capability read in the same file: one of the gates, or the wire re-check
 * (`aiEgressRefusal` / `assertAiEgress`), which also answers the consent a
 * picked provider needs.
 */
const CAPABILITY_CHECK =
  /\b(?:aiCapabilityForJob|aiCapabilityForRecord|requireAiCapability|getAiCapability|aiEgressRefusal|assertAiEgress)\s*\(/;

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function code(rel: string): string {
  return stripComments(readFileSync(join(SRC, rel), "utf8"));
}

interface EgressSite {
  /** True when this file is a chokepoint and must re-check a capability. */
  recheck: boolean;
  reason: string;
}

/**
 * Every file that calls a provider, and why the call is admitted.
 */
const EGRESS_SITES: Record<string, EgressSite> = {
  // ── Chokepoints: re-check at the wire ──────────────────────────────────
  "lib/insights/status-provider.ts": {
    recheck: true,
    reason:
      "runStatusCompletion: status notes, narratives, workout paragraphs, derived and biomarker assessments, Coach memory. Takes the capability as a required argument and re-checks it before the chain is resolved.",
  },
  "lib/jobs/reaction-line.ts": {
    recheck: true,
    reason:
      "Reaction lines call the first chain entry directly; the worker resolves `reactionLines` before the digest and re-checks the chain at the wire (`aiEgressRefusal`).",
  },
  "lib/jobs/coach-nudge-ai.ts": {
    recheck: true,
    reason:
      "AI-composed nudges call the first chain entry directly; the composer re-checks `coach` before the chain.",
  },

  // ── Admitted by the one caller that reaches them ───────────────────────
  "lib/insights/briefing-provider.ts": {
    recheck: false,
    reason:
      "Reached only through generateComprehensiveInsight, which re-checks `briefing` before the chain is resolved.",
  },
  "lib/ai/coach/tools/loop.ts": {
    recheck: false,
    reason:
      "The Coach tool loop runs inside the chat stream, which the chat route gates on `coach`.",
  },
  "lib/ai/coach/self-context-questions.ts": {
    recheck: false,
    reason:
      "About-me follow-up questions; reached from the about-me route, which gates `aboutMeQuestions`.",
  },
  "lib/documents/assist.ts": {
    recheck: false,
    reason:
      "Document suggest/chat helpers; reached from the document routes and jobs, which resolve `documentAi` before a provider is picked.",
  },
  "lib/documents/describe.ts": {
    recheck: false,
    reason:
      "Document summary and transcription; reached from the summary and index routes, the summary job, and the background run worker (`lib/jobs/document-ai-run.ts`), which resolve `documentAi` first.",
  },
  "lib/documents/extract.ts": {
    recheck: false,
    reason:
      "Document extraction/indexing; reached from the document routes and the index jobs, which resolve `documentAi` first.",
  },
  "lib/medications/ingredients/label-extract.ts": {
    recheck: false,
    reason:
      "Supplement label read (v1.43); reached from the background run worker (`lib/jobs/document-ai-run.ts`), which re-checks `supplementLabel` for the picked provider, for a label the ingredients extract route queued under that capability.",
  },
  "lib/labs/ocr-extract.ts": {
    recheck: true,
    reason:
      "Lab report scan; reached from the background run worker (`lib/jobs/document-ai-run.ts`), which checks `labsOcr` for the picked provider before the first read. A long report's reads run for many minutes after that, so every further read re-checks the wire (`aiEgressRefusal`) and stops when AI was turned off meanwhile.",
  },
  "app/api/medications/extract/route.ts": {
    recheck: false,
    reason:
      "Medication text extraction; the route is the chokepoint for `medicationExtract`.",
  },
  "app/api/ai/test/route.ts": {
    recheck: false,
    reason:
      "The connection test a person runs on a provider they are configuring; it sends a fixed probe prompt, no health data.",
  },

  // ── The machinery itself ────────────────────────────────────────────────
  "lib/ai/provider-runner.ts": {
    recheck: false,
    reason: "The chain runners; every caller above is what admits a run.",
  },
  "lib/ai/openai-client.ts": {
    recheck: false,
    reason: "A wire client delegating to its own completion method.",
  },
  "lib/ai/local-client.ts": {
    recheck: false,
    reason: "A wire client delegating to its own completion method.",
  },
  "lib/ai/coach/eval/judge.ts": {
    recheck: false,
    reason: "The offline evaluation harness; never on a request or job path.",
  },
  "lib/ai/coach/eval/run-case.ts": {
    recheck: false,
    reason:
      "The offline evaluation harness's live scenario run, called only by judge.ts; never on a request or job path.",
  },
};

/**
 * Background workers that reach one of the admitted helpers above with no
 * request around them. The route that queued the work asked the capability
 * once; the worker runs later, after a switch may have been turned off or
 * consent withdrawn, so it must ask again for the record and re-check the wire
 * for the provider it picked.
 */
const WORKER_REACHERS: Record<string, string> = {
  "lib/jobs/document-ai-run.ts":
    "Background document reads and lab scans (v1.40): `transcribeDocument`, `runDocumentSummary`, `runDocumentAssist` and `runOcrExtraction` through the shared run bodies.",
};

const JOB_CAPABILITY = /\baiCapabilityForJob\s*\(/;
const WIRE_RECHECK = /\baiEgressRefusal\s*\(/;

describe("workers that reach an admitted helper", () => {
  it.each(Object.keys(WORKER_REACHERS))(
    "%s asks the capability for the record and re-checks the wire",
    (rel) => {
      const text = code(rel);
      expect(JOB_CAPABILITY.test(text), `${rel}: no aiCapabilityForJob`).toBe(
        true,
      );
      expect(WIRE_RECHECK.test(text), `${rel}: no aiEgressRefusal`).toBe(true);
    },
  );

  it("a worker whose re-check is only in a comment fails the matcher", () => {
    const planted = stripComments(
      "// aiEgressRefusal(key, userId, types)\nawait aiCapabilityForJob(userId, key);",
    );
    expect(JOB_CAPABILITY.test(planted)).toBe(true);
    expect(WIRE_RECHECK.test(planted)).toBe(false);
  });
});

/** The body of one top-level `async function name(` in a source text. */
function functionBody(text: string, name: string): string | null {
  const start = text.search(new RegExp(`async function ${name}\\s*\\(`));
  if (start < 0) return null;
  const end = text.indexOf("\n}\n", start);
  return end < 0 ? null : text.slice(start, end);
}

describe("every kind of background run re-checks before its read", () => {
  const worker = code("lib/jobs/document-ai-run.ts");
  const table = /const RUN_DISPATCH[^=]*=\s*\{([\s\S]*?)\};/.exec(worker);
  const entries = [...(table?.[1] ?? "").matchAll(/(\w+):\s*(\w+),/g)].map(
    (m) => ({ kind: m[1], dispatcher: m[2] }),
  );

  it("finds the dispatch table (an empty match is a failure, not a pass)", () => {
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it("dispatches every run kind", () => {
    expect(entries.map((e) => e.kind).sort()).toEqual(
      [...DOCUMENT_AI_RUN_KINDS].sort(),
    );
  });

  it("the shared document pick re-checks the wire on both transports", () => {
    const pick = functionBody(worker, "pickForDocumentRead") ?? "";
    expect(pick.match(/\bassertRunMayEgress\s*\(/g)?.length ?? 0).toBe(2);
  });

  it.each(DOCUMENT_AI_RUN_KINDS)(
    "%s re-checks the capability and the wire before the body runs",
    (kind) => {
      const entry = entries.find((e) => e.kind === kind);
      const body = entry ? functionBody(worker, entry.dispatcher) : null;
      expect(body, `${kind}: dispatcher not found`).not.toBeNull();
      expect(
        /\b(?:assertRunMayEgress|pickForDocumentRead)\s*\(/.test(body ?? ""),
        `${kind}: its dispatcher sends to a model without assertRunMayEgress`,
      ).toBe(true);
    },
  );
});

describe("AI egress call sites", () => {
  const found = sourceFiles().filter((rel) => EGRESS_CALL.test(code(rel)));

  it("finds provider calls at all (an empty matcher is a failure, not a pass)", () => {
    expect(found.length).toBeGreaterThan(5);
  });

  it("every provider call site is named, with a reason", () => {
    const unlisted = found.filter((rel) => !(rel in EGRESS_SITES));
    expect(
      unlisted,
      "A new file calls a provider. Add it to EGRESS_SITES with the reason its call is admitted, and re-check a capability in it if it is a chokepoint.",
    ).toEqual([]);
  });

  it("the list carries no file that no longer calls a provider", () => {
    const stale = Object.keys(EGRESS_SITES).filter(
      (rel) => !found.includes(rel),
    );
    expect(stale).toEqual([]);
  });

  it("every chokepoint re-checks a capability in the same file", () => {
    const missing = Object.entries(EGRESS_SITES)
      .filter(([, site]) => site.recheck)
      .filter(([rel]) => !CAPABILITY_CHECK.test(code(rel)))
      .map(([rel]) => rel);
    expect(missing).toEqual([]);
  });
});

describe("the status chokepoint's capability argument", () => {
  it("is required by the type (the @ts-expect-error below fails typecheck if it is not)", () => {
    type Args = Parameters<typeof runStatusCompletion>[0];
    // @ts-expect-error — `capability` is required: a caller that omits it does not compile.
    const withoutCapability: Args = {
      userId: "u",
      cacheAction: "insights.weight-status.en",
      systemPrompt: "s",
      userPrompt: "p",
    };
    const withCapability: Args = {
      ...withoutCapability,
      capability: "statusText",
    };
    expect(withCapability.capability).toBe("statusText");
  });
});

/**
 * Workout GPS tracks never reach a model.
 *
 * A route shows where a person lives, works and trains, and it is stored only
 * after an opt-in. So the set of files that can open or write a track is
 * frozen here, with the reason each needs it, and none of them may be a
 * provider call site or sit in an AI module. The workout insight used to open
 * the track to derive metres climbed; that figure is now filled into
 * `Workout.elevationM` at write time (`route-climb.ts`), and the insight reads
 * the column. A new reader fails the first check until someone decides, here,
 * that it is not an AI path.
 *
 * Limit: the matcher looks for the cipher helpers, the sealed column and a
 * `geometry: true` select. A read under some other spelling (a raw SQL
 * `SELECT geometry_encrypted`, a backup dumping the model generically) would
 * slip it. The generic backup dump and restore do carry the sealed column;
 * they are not AI paths and hand it to no model.
 */
describe("workout route geometry never reaches an AI path", () => {
  const ROUTE_READER =
    /\breadRouteGeometry\s*\(|\bencryptRouteGeometry\s*\(|\bgeometryEncrypted\b|\bgeometry\s*:\s*true\b/;

  const ROUTE_READERS: Record<string, string> = {
    "lib/workouts/detail.ts":
      "The workout detail read: serves the track to the person's own map.",
    "lib/workouts/batch-ingest/write.ts":
      "The workout batch ingest's write: stores a kept track (opt-in), sealed.",
    "lib/apple-health/route-import.ts":
      "Writes a kept track from the Apple Health export (opt-in).",
    "lib/crypto/encrypted-columns.ts":
      "The encrypted-column registry the key rotation walks.",
    "lib/jobs/free-text-encryption-backfill.ts":
      "Seals legacy readable tracks in place.",
    "lib/workouts/route-geometry-cipher.ts": "The cipher itself.",
    "lib/workouts/climb-backfill.ts":
      "One-time backfill: derives metres climbed into Workout.elevationM.",
  };

  /** Directories whose code feeds a model. */
  const AI_AREAS = [
    "lib/ai/",
    "lib/insights/",
    "lib/mcp/",
    "app/mcp/",
    "app/api/insights/",
    "app/api/coach/",
  ];

  const found = sourceFiles().filter((rel) => ROUTE_READER.test(code(rel)));

  it("finds route readers at all (an empty matcher is a failure, not a pass)", () => {
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it("every file that opens or writes a track is named, with a reason", () => {
    expect(found.filter((rel) => !(rel in ROUTE_READERS))).toEqual([]);
  });

  it("the list carries no file that no longer touches a track", () => {
    expect(
      Object.keys(ROUTE_READERS).filter((rel) => !found.includes(rel)),
    ).toEqual([]);
  });

  it("no route reader calls a provider or lives in an AI module", () => {
    for (const rel of Object.keys(ROUTE_READERS)) {
      expect(rel in EGRESS_SITES, `${rel} is an egress site`).toBe(false);
      expect(EGRESS_CALL.test(code(rel)), `${rel} calls a provider`).toBe(
        false,
      );
      expect(
        AI_AREAS.some((area) => rel.startsWith(area)),
        `${rel} sits in an AI module`,
      ).toBe(false);
    }
  });

  it("the workout insight job does not read the track", () => {
    const job = code("lib/jobs/workout-insight-generate.ts");
    expect(job).not.toMatch(/\broute\s*:/);
    expect(job).not.toMatch(ROUTE_READER);
  });
});
