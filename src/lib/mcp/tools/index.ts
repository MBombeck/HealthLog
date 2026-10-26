/**
 * Transport-agnostic MCP read-tool registry.
 *
 * Each tool is a THIN wrapper over an existing server-authoritative read path —
 * the Coach F1 retrieval layer (`@/lib/ai/coach/tools`). No new analytics is
 * computed here (REQ-WONT-2); the MCP wire only re-exports what HealthLog
 * already computes. The same registry feeds both transports: the stdio adapter
 * and the remote `/mcp` adapter register from it, so the tool contract can
 * never fork between wires (ADR-002).
 *
 * Grounding contract (REQ-SEC-2/3/4, ADR-004): every tool returns structured
 * values + units + reference bands + provenance and uses `{ present: false }`
 * for absence — never a silent zero, never a prose verdict or diagnosis. The
 * assistant narrates; the server only ships facts it computed.
 *
 * Read-only contract (REQ-SEC-1, ADR-003): the registry contains read tools
 * only. `userId` is always taken from the resolved session context, never from a
 * tool argument (REQ-SEC-5).
 *
 * One module per tool in this folder; this file only fixes the order the
 * tools are advertised in, which is part of the wire contract
 * (`__tests__/tools-list-snapshot.test.ts` pins it).
 */
import type { McpToolDefinition } from "./types";
import { listMetricsTool } from "./list-metrics";
import { getMetricSeriesTool } from "./get-metric-series";
import { getMedicationComplianceTool } from "./get-medication-compliance";
import { getLabsTool } from "./get-labs";
import { getCorrelationsTool } from "./get-correlations";
import { getCorrelationTool } from "./get-correlation";
import { compareMetricTool } from "./compare-metric";
import { getMetricBaselineTool } from "./get-metric-baseline";
import { detectChangepointsTool } from "./detect-changepoints";
import { getGlucosePanelTool } from "./get-glucose-panel";
import { getSleepTool } from "./get-sleep";
import { getWorkoutsTool } from "./get-workouts";
import { getIllnessRecoveryTool } from "./get-illness-recovery";
import { getCycleTool } from "./get-cycle";
import { getEnvironmentTool } from "./get-environment";
import { getDayTool } from "./get-day";
import { getMetricsTool } from "./get-metrics";
import { getMedicationScheduleTool } from "./get-medication-schedule";
import { getIntegrationStatusTool } from "./get-integration-status";
import { getPreventiveCareTool } from "./get-preventive-care";
import { getNutrientsTool } from "./get-nutrients";
import { getIntradayPulseTool } from "./get-intraday-pulse";
import { getEcgRecordingsTool } from "./get-ecg-recordings";
import { getVisitsTool } from "./get-visits";
import { searchTool } from "./search";
import { fetchTool } from "./fetch";

export const MCP_TOOLS: McpToolDefinition[] = [
  listMetricsTool,
  getMetricSeriesTool,
  getMedicationComplianceTool,
  getLabsTool,
  getCorrelationsTool,
  // Deep-value reads over the rich-read engines.
  getCorrelationTool,
  compareMetricTool,
  getMetricBaselineTool,
  detectChangepointsTool,
  // Coach-F1 reads bridged to the wire. Each is a thin `runCoachTool` glue
  // over an already-built, grounded Coach retrieval tool — same gates, units,
  // and `{ present: false }` contract. The `list_metrics` inventory already
  // advertises these, so wiring them here closes the prior
  // advertise-but-missing self-inconsistency.
  getGlucosePanelTool,
  getSleepTool,
  getWorkoutsTool,
  getIllnessRecoveryTool,
  getCycleTool,
  getEnvironmentTool,
  getDayTool,
  // Multi-metric fan-out.
  getMetricsTool,
  // Operational reads (not Coach snapshot domains).
  getMedicationScheduleTool,
  getIntegrationStatusTool,
  getPreventiveCareTool,
  // The nutrients pipeline, the intraday pulse, ECG recording metadata and
  // the visit history.
  getNutrientsTool,
  getIntradayPulseTool,
  getEcgRecordingsTool,
  getVisitsTool,
  // The `search` + `fetch` pair ChatGPT calls in its default mode.
  searchTool,
  fetchTool,
];

/** Stable list of the registered tool names. */
export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((t) => t.name);
