/**
 * Every MCP read has a Coach counterpart, or a written reason it has none.
 *
 * The seizure diary had an MCP tool and a report section, and the Coach knew
 * nothing of it: a carer asking the in-app Coach about seizures since a new
 * dose got "no data" while Claude over MCP answered from the same record. The
 * class is a new data area that reaches MCP and not the Coach.
 *
 * So each MCP tool is listed here with one of: the Coach tool of the same
 * name, the Coach snapshot block that carries the same data (which must be
 * assigned in the snapshot builders), or the reason the Coach does without.
 * A new MCP tool without an entry fails, and so does an entry for a tool
 * that is gone.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { COACH_TOOL_NAMES } from "@/lib/ai/coach/tools/definitions";
import { MCP_TOOL_NAMES } from "@/lib/mcp/tools";

import { readSourceText, walkSourceFiles } from "./helpers/source-files";

type Counterpart =
  { coachTool: string } | { snapshotBlock: string } | { reason: string };

const COUNTERPARTS: Record<string, Counterpart> = {
  list_metrics: {
    reason:
      "Discovery for a connector that starts empty; the Coach snapshot lists the record's metrics itself.",
  },
  get_metric_series: { coachTool: "get_metric_series" },
  get_medication_compliance: { coachTool: "get_medication_compliance" },
  get_labs: { coachTool: "get_labs" },
  get_correlations: { coachTool: "get_correlations" },
  get_correlation: { coachTool: "get_correlations" },
  compare_metric: { coachTool: "get_metric_table" },
  get_metric_baseline: { coachTool: "get_metric_table" },
  detect_changepoints: { snapshotBlock: "changepoints" },
  get_glucose_panel: { coachTool: "get_glucose_panel" },
  get_sleep: { coachTool: "get_sleep" },
  get_workouts: { coachTool: "get_workouts" },
  get_illness_recovery: { coachTool: "get_illness_recovery" },
  get_cycle: { coachTool: "get_cycle" },
  get_environment: { coachTool: "get_environment" },
  get_day: { coachTool: "get_day" },
  get_metrics: { coachTool: "get_metric_table" },
  get_medication_schedule: { snapshotBlock: "compliance" },
  get_integration_status: {
    reason:
      "Which integrations sync and which fail is operational state, not the health record the Coach talks about.",
  },
  get_preventive_care: {
    reason:
      "Due vaccinations and check-ups are a calendar the app shows and reminds of; the Coach does not schedule care.",
  },
  get_nutrients: { snapshotBlock: "energyBalance" },
  get_intraday_pulse: { coachTool: "get_day" },
  get_ecg_recordings: {
    reason:
      "An ECG strip's classification is the device's and the doctor's to read; the Coach does not interpret strips.",
  },
  get_visits: { snapshotBlock: "visits" },
  get_seizures: { snapshotBlock: "seizures" },
  search: {
    reason:
      "Lookup by name for a connector's default mode; the Coach carries visits, labs and illness as blocks.",
  },
  fetch: { reason: "The record `search` found, by id; see `search`." },
};

const COACH_SNAPSHOT_DIR = join(process.cwd(), "src", "lib", "ai", "coach");

function snapshotKeys(): Set<string> {
  const keys = new Set<string>();
  const files = walkSourceFiles(COACH_SNAPSHOT_DIR, { floor: 50 }).filter(
    (p) => !p.includes("__tests__") && /\.ts$/.test(p),
  );
  for (const file of files) {
    const code = readSourceText(join(COACH_SNAPSHOT_DIR, file));
    for (const m of code.matchAll(/\bsnapshot\.([A-Za-z]+)\s*=/g)) {
      keys.add(m[1]);
    }
  }
  return keys;
}

describe("MCP reads and the Coach", () => {
  const keys = snapshotKeys();

  it("list every MCP tool", () => {
    expect(MCP_TOOL_NAMES.length).toBeGreaterThanOrEqual(20);
    expect(
      MCP_TOOL_NAMES.filter((n) => !(n in COUNTERPARTS)),
      "Give the Coach the same data (a tool or a snapshot block), or write down why it does without.",
    ).toEqual([]);
  });

  it("list no tool that is gone", () => {
    expect(
      Object.keys(COUNTERPARTS).filter((n) => !MCP_TOOL_NAMES.includes(n)),
    ).toEqual([]);
  });

  it("name counterparts that exist", () => {
    for (const [tool, c] of Object.entries(COUNTERPARTS)) {
      if ("coachTool" in c) {
        expect(COACH_TOOL_NAMES as readonly string[], tool).toContain(
          c.coachTool,
        );
      }
      if ("snapshotBlock" in c) {
        expect([...keys], tool).toContain(c.snapshotBlock);
      }
    }
  });
});
