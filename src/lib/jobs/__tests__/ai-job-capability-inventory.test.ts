/**
 * Every background job that writes model text resolves its AI capability.
 *
 * The rule for jobs (design: "AI optional"): a worker resolves its capability
 * for the user before it builds a snapshot and skips with a `.skipped`
 * annotation when the answer is no; the provider chokepoint re-checks at the
 * wire. This freezes the first half as a reference: each file below must call
 * the named gate with the named capability key.
 *
 * It proves a reference exists, not that it sits before the snapshot or on
 * every branch. The integration suite (`tests/integration/ai-optional-jobs.test.ts`)
 * runs each worker under the refusing states with a provider spy and is what
 * proves behaviour.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AI_CAPABILITY_KEYS,
  type AiCapabilityKey,
} from "@/lib/ai/capabilities/types";
import { stripComments } from "../../../__tests__/helpers/source-files";

const ROOT = join(process.cwd(), "src");

type Gate =
  "aiCapabilityForJob" | "aiCapabilityForRecord" | "aiWorkNotRuledOut";

interface JobGate {
  gate: Gate;
  keys: readonly AiCapabilityKey[];
}

/** Every AI job (and the enqueue sides that decide whether one is queued). */
const AI_JOBS: Record<string, JobGate> = {
  "lib/jobs/insight-pregenerate.ts": {
    gate: "aiCapabilityForJob",
    keys: ["briefing", "statusText"],
  },
  "lib/insights/status-batch.ts": {
    gate: "aiCapabilityForJob",
    keys: ["statusText"],
  },
  "lib/jobs/insight-status-generate.ts": {
    gate: "aiCapabilityForJob",
    keys: ["statusText"],
  },
  "lib/jobs/period-narrative-warm.ts": {
    gate: "aiCapabilityForJob",
    keys: ["periodNarrative"],
  },
  "lib/jobs/coach-nudge.ts": { gate: "aiCapabilityForJob", keys: ["coach"] },
  "lib/jobs/coach-nudge-ai.ts": { gate: "aiCapabilityForJob", keys: ["coach"] },
  "lib/ai/coach/coach-memory-refresh-worker.ts": {
    gate: "aiCapabilityForJob",
    keys: ["coach"],
  },
  "lib/jobs/reaction-line.ts": {
    gate: "aiCapabilityForJob",
    keys: ["reactionLines"],
  },
  "lib/jobs/workout-insight-generate.ts": {
    gate: "aiCapabilityForJob",
    keys: ["workoutInsights"],
  },
  "lib/jobs/document-summary.ts": {
    gate: "aiCapabilityForJob",
    keys: ["documentAi"],
  },
  "lib/jobs/document-summary-catchup.ts": {
    gate: "aiCapabilityForJob",
    keys: ["documentAi"],
  },
  "lib/jobs/document-content-index-backfill.ts": {
    gate: "aiCapabilityForJob",
    keys: ["documentAi"],
  },
  // The arrival spine may not import the provider machinery, so it asks the
  // provider-free half before it enqueues; the jobs resolve the rest.
  "lib/jobs/data-arrival.ts": {
    gate: "aiWorkNotRuledOut",
    keys: ["workoutInsights", "reactionLines"],
  },
  // Enqueue sides reached from requests and jobs alike.
  "lib/insights/status-invalidation.ts": {
    gate: "aiCapabilityForRecord",
    keys: ["statusText"],
  },
};

function code(rel: string): string {
  return stripComments(readFileSync(join(ROOT, rel), "utf8"), rel);
}

describe("AI job capability inventory", () => {
  const entries = Object.entries(AI_JOBS);

  it("is not empty", () => {
    expect(entries.length).toBeGreaterThan(10);
  });

  it("names only capabilities that exist", () => {
    for (const [, { keys }] of entries) {
      for (const key of keys) expect(AI_CAPABILITY_KEYS).toContain(key);
    }
  });

  it.each(entries)("%s resolves its capability", (rel, { gate, keys }) => {
    const source = code(rel);
    for (const key of keys) {
      const call = new RegExp(`\\b${gate}\\s*\\([^)]*?["']${key}["']`);
      expect(
        call.test(source),
        `${rel} must call ${gate}(…, "${key}") before it does model work`,
      ).toBe(true);
    }
  });
});
