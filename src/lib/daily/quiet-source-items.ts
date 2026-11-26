/**
 * The Today rail's line for a source that has gone quiet.
 *
 * Which source is quiet, and since when, is the stall rule's answer
 * (`src/lib/sync-stall/quiet.ts`), the same the push and the integration card
 * give; the IO seam reads it through `loadDigestQuietSources` and words the
 * date, so this builder stays pure. Pure, type imports only.
 */
import type { ServerTranslator } from "@/lib/i18n/server-translator";
import type { DailyDigestSyncIssue } from "@/lib/daily/digest";
import type { PriorityItem } from "@/lib/daily/priority-item";

/** A quiet source, already worded for the reader. */
export interface DailyDigestQuietSource {
  /** Connection key (`apple-health`, `oura`, …). */
  source: string;
  /** Provider name, the same in every language. */
  provider: string;
  /** The last delivery was on the reader's previous local day (or later). */
  sinceYesterday: boolean;
  /** The last delivery's short local date ("Nov 19"). */
  date: string;
  /** The source's own card on the integrations page. */
  href: string;
}

/**
 * One rail item per quiet source, with its own card as the one action. A
 * source that already has a sync issue (a reconnect or a resume) is named
 * there, not twice.
 */
export function quietSourceItems(
  input: {
    quietSources?: readonly DailyDigestQuietSource[];
    syncIssues: readonly DailyDigestSyncIssue[];
  },
  t: ServerTranslator["t"],
): PriorityItem[] {
  const named = new Set(input.syncIssues.map((issue) => issue.integration));
  return (input.quietSources ?? [])
    .filter((q) => !named.has(q.source))
    .map((q) => ({
      kind: "sync_issue" as const,
      title: q.sinceYesterday
        ? t("daily.item.sourceQuiet.sinceYesterday", { source: q.provider })
        : t("daily.item.sourceQuiet.since", {
            source: q.provider,
            date: q.date,
          }),
      status: "info" as const,
      actions: [
        {
          labelKey: "daily.action.openSource",
          // `sync.reconnect`, not a new token: every shipped iOS build routes
          // it to the integrations screen and shows its generic label for a
          // label key it does not know. A new intent would be a dead button
          // there. The href names the source's own card for the web.
          intent: "sync.reconnect",
          href: q.href,
        },
      ],
    }));
}
