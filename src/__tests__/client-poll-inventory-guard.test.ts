/**
 * Structural guard: every client poll is in the inventory, in one of the
 * three shapes `src/lib/queries/refetch-interval.ts` describes.
 *
 * The inventory used to be a comment, and a comment cannot fail: three polls
 * (the Insights shell's briefing, the medication compliance card and two of
 * the status hooks' cards) were missing from it. Here it is data, held to
 * every `refetchInterval:` in the tree, with the number each file carries, so
 * a new poll in a listed file fails as surely as one in a new file.
 *
 * A bounded poll counts its attempts with `pollAttemptCount`, failed fetches
 * included: on `dataUpdateCount` alone a request that kept failing kept the
 * last good payload (still `preparing`) and polled for as long as the page
 * stayed open.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

type Shape = "standing" | "until-done" | "bounded";

interface Poll {
  /** How many `refetchInterval:` the file holds. */
  sites: number;
  shape: Shape;
  /** The interval, and why that figure; or what ends the poll. */
  cadence: string;
}

const INVENTORY: Readonly<Record<string, Poll>> = {
  // ── Standing: a fixed interval while mounted, paused on a hidden tab ──
  "lib/queries/use-dashboard-snapshot.ts": {
    sites: 1,
    shape: "standing",
    cadence:
      "120 s, DASHBOARD_REFETCH_INTERVAL_MS; matches the snapshot cache TTL",
  },
  "lib/queries/use-analytics-query.ts": {
    sites: 1,
    shape: "standing",
    cadence: "120 s, DASHBOARD_REFETCH_INTERVAL_MS",
  },
  "lib/queries/use-daily-digest.ts": {
    sites: 1,
    shape: "standing",
    cadence: "120 s, DASHBOARD_REFETCH_INTERVAL_MS",
  },
  "components/settings/notification-status-card.tsx": {
    sites: 1,
    shape: "standing",
    cadence: "30 s; last-delivery results move while the panel is open",
  },
  "components/admin/app-log-preview-section.tsx": {
    sites: 1,
    shape: "standing",
    cadence: "30 s; an operator watching a live log",
  },
  "components/gamification/achievement-unlock-notifier.tsx": {
    sites: 1,
    shape: "standing",
    cadence: "5 min; out-of-band unlocks, an app-global poll",
  },
  "components/admin/host-metrics-chart.tsx": {
    sites: 1,
    shape: "standing",
    cadence: "5 min; the sampler's own cadence",
  },
  // ── Until done: stops on a terminal state the server always reaches ──
  "components/settings/import-panel/apple-health-import-card.tsx": {
    sites: 1,
    shape: "until-done",
    cadence: "2 s until the job reports a terminal status",
  },
  "components/settings/import-panel/health-connect-import-card.tsx": {
    sites: 1,
    shape: "until-done",
    cadence: "2 s until the job reports a terminal status",
  },
  "components/admin/backups/use-backup-restores.ts": {
    sites: 1,
    shape: "until-done",
    cadence: "2 s until no restore is active",
  },
  "components/documents/vault/use-vault-library.ts": {
    sites: 1,
    shape: "until-done",
    cadence:
      "4 s until no document is inside its 3-minute upload window without an index",
  },
  "components/insights/coach-panel/coach-conversation.tsx": {
    sites: 1,
    shape: "until-done",
    cadence:
      "2.5 s until the attachment is indexed or its upload window passed",
  },
  "components/admin/pulse-day-mean-card.tsx": {
    sites: 1,
    shape: "until-done",
    cadence: "10 s until the recompute reports done",
  },
  "components/admin/measurement-maintenance-card.tsx": {
    sites: 1,
    shape: "until-done",
    cadence: "10 s until the run reports done",
  },
  "components/insights/period-narrative-card.tsx": {
    sites: 1,
    shape: "until-done",
    cadence:
      "5 s until the narrative arrives or `revalidating` clears; only mounted while looked at",
  },
  // ── Bounded: model text on its way, with an attempt ceiling ──
  "hooks/use-insight-status.ts": {
    sites: 3,
    shape: "bounded",
    cadence:
      "4 s, nextStatusPollInterval, 12 attempts (metric, biomarker, general cards)",
  },
  "app/insights/medications/page.tsx": {
    sites: 1,
    shape: "bounded",
    cadence: "4 s, nextStatusPollInterval, 12 attempts (compliance card)",
  },
  "components/insights/use-insights-advisor.ts": {
    sites: 1,
    shape: "bounded",
    cadence:
      "25 s, nextAdvisorPollInterval, attempts from the response timeout so the warm can land (advisor); 10 while settling",
  },
  "components/insights/insights-layout-shell.tsx": {
    sites: 1,
    shape: "bounded",
    cadence: "25 s, nextAdvisorPollInterval, 10 attempts (briefing body)",
  },
};

const SITE = /\brefetchInterval\s*:/g;

const files = walkSourceFiles(SRC, { floor: 3000 }).filter(
  (f) =>
    !f.startsWith("generated/") &&
    !f.includes("__tests__/") &&
    !/\.test\.tsx?$/.test(f),
);
const code = new Map(
  files.map((f) => [f, stripComments(readFileSync(join(SRC, f), "utf8"))]),
);
const sitesIn = (text: string) => text.match(SITE)?.length ?? 0;

describe("client polls", () => {
  it("lists every poll in the tree, with the number each file holds", () => {
    const found = requireFloor(
      "refetchInterval files",
      files.filter((f) => sitesIn(code.get(f)!) > 0),
      15,
    );
    const drift = found
      .filter((f) => INVENTORY[f]?.sites !== sitesIn(code.get(f)!))
      .map((f) => `${f}: ${sitesIn(code.get(f)!)}`);
    expect(drift).toEqual([]);
    const gone = Object.keys(INVENTORY).filter((f) => !found.includes(f));
    expect(gone).toEqual([]);
  });

  it("counts a bounded poll's attempts with the failed fetches", () => {
    const bounded = Object.entries(INVENTORY).filter(
      ([, p]) => p.shape === "bounded",
    );
    const problems = bounded.flatMap(([f, p]) => {
      const text = code.get(f) ?? "";
      const counted =
        text.match(/pollAttemptCount\(query\.state\)/g)?.length ?? 0;
      return [
        ...(counted < p.sites
          ? [`${f}: ${counted} of ${p.sites} counted`]
          : []),
        ...(/\.state\.dataUpdateCount\b/.test(text)
          ? [`${f}: reads dataUpdateCount alone`]
          : []),
      ];
    });
    expect(problems).toEqual([]);
  });

  it("catches an unlisted poll", () => {
    expect(sitesIn("useQuery({ refetchInterval: 5_000 })")).toBe(1);
    expect(sitesIn("// refetchInterval: 5_000")).toBe(1);
    expect(sitesIn(stripComments("// refetchInterval: 5_000"))).toBe(0);
  });
});
