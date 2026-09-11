import type {
  IntegrationKey,
  IntegrationState,
} from "@/lib/integrations/status";

/**
 * A status-ledger row alone cannot prove a connection: integrations without a
 * row synthesize a healthy ledger state for the owner Settings dashboard. The
 * managed projection must instead report those as disconnected until its
 * record carries a real credential or connection row.
 */
export function resolveManagedIntegrationState(
  state: IntegrationState,
  connected: Record<IntegrationKey, boolean>,
  integration: IntegrationKey,
): IntegrationState {
  if (!connected[integration]) return "disconnected";
  // v1.38.19 — `unknown` is the ledger saying it holds no row. The managed
  // projection publishes a closed vocabulary its card paints from, and
  // "no history" is not one of its states, so it reads as `disconnected`
  // here exactly as it does everywhere else.
  return state === "unknown" ? "disconnected" : state;
}
