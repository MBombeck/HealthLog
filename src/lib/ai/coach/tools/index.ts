/**
 * v1.20.0 (F1) — Coach retrieval-tool barrel.
 *
 * The on-demand retrieval slice that replaces snapshot-stuffing: a tiny DATA
 * INVENTORY in the base context, six read-only tools the model calls to fetch
 * figures, and a bounded loop that executes them. The legacy snapshot path
 * stays alive as the no-tools fallback (per-provider `supportsTools`).
 */
export { COACH_TOOL_DEFS, parseCoachToolArgs } from "./definitions";
export type { CoachToolTrace } from "./executor";
export {
  buildCoachDataInventory,
  renderDataInventory,
  renderFocusHint,
} from "./inventory";
export { buildToolModeAddendum } from "./system-addendum";
export { runCoachToolLoop } from "./loop";
