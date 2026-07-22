/**
 * Generator-free enqueue contract for the `reaction-line-generate` queue.
 *
 * Same split as `emit-shared.ts`, and for the same reason: the spine's worker
 * (`@/lib/jobs/data-arrival`) must be able to ENQUEUE a reaction line without
 * importing the module that GENERATES one. The generator reaches a provider;
 * the spine's central cost claim is that it structurally cannot. A shared
 * queue-name-plus-payload module is what keeps both true at once, and the
 * spine's module-graph guard (`data-arrival-provider-isolation.test.ts`)
 * fails the moment this file grows an import that breaks it.
 *
 * Keep this module provider-free and worker-free.
 */
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";

import type { ArrivalKind } from "./types";

export const REACTION_LINE_QUEUE = "reaction-line-generate";

/**
 * The generation job's payload. It carries the row identity plus the exact
 * marker revision the worker may generate. The worker binds every read and
 * write to that revision so a queued job cannot follow a same-day replacement.
 */
export interface ReactionLineJob {
  userId: string;
  kind: ArrivalKind;
  /** The user's profile-tz YYYY-MM-DD the marker is filed under. */
  localDate: string;
  /** Exact `occurredAt` timestamp of the marker revision to generate. */
  revision: string;
}

/**
 * Enqueue reaction-line generation for one arrival marker revision.
 *
 * The caller owns the durable throttle. Fresh inserts and strictly newer
 * replacements enqueue after atomically establishing their marker revision;
 * equal or older arrivals do not. The singleton key includes that revision so
 * an older queued job cannot suppress a replacement. The worker re-reads and
 * conditionally claims the row, which prevents stale jobs from publishing.
 *
 * Never throws. A queue that is not there means no line, and no line is a
 * fully-supported state.
 */
export async function enqueueReactionLine(job: ReactionLineJob): Promise<void> {
  try {
    const boss = getGlobalBoss();
    if (!boss) {
      annotate({
        action: { name: "arrival.reaction_line.skipped" },
        meta: { reason: "no_boss", kind: job.kind },
      });
      return;
    }

    await boss.send(REACTION_LINE_QUEUE, job, {
      singletonKey: `reaction-line:${job.userId}:${job.kind}:${job.localDate}:${job.revision}`,
      // Only failures before a provider invocation are retryable. Once the
      // durable worker state records that spend may have happened, the attempt
      // is terminal even if the provider or final persistence fails.
      retryLimit: 1,
      retryDelay: 120,
      retryBackoff: true,
    });

    annotate({
      action: { name: "arrival.reaction_line.enqueued" },
      meta: { kind: job.kind, local_date: job.localDate },
    });
  } catch {
    // The data landed and the marker is written; the sentence is garnish.
  }
}
