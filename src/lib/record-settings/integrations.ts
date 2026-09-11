import type {
  IntegrationKey,
  IntegrationState,
} from "@/lib/integrations/status";

/**
 * A status-ledger row alone cannot prove a connection: integrations without a
 * row synthesize a ledger state the owner Settings dashboard reads. The
 * managed projection must instead report those as disconnected until its
 * record carries a real credential or connection row.
 *
 * This projection's `state` says whether a pipe exists, never whether it is
 * live — liveness is `syncHealth.verdict`, and the card beside this pill
 * reads that. So the connection map decides first, and only then does the
 * ledger state refine the answer.
 */
export function resolveManagedIntegrationState(
  state: IntegrationState,
  connected: Record<IntegrationKey, boolean>,
  integration: IntegrationKey,
): IntegrationState {
  if (!connected[integration]) return "disconnected";
  // v1.38.19 — `unknown` is the ledger saying it holds no row, and past the
  // gate above that means a real credential exists whose first sync has not
  // landed yet. "A pipe exists" is exactly what this field reports, so it
  // reads `connected`. Reporting "Not connected" over a credential the
  // guardian created minutes ago invites them to revoke and redo the grant,
  // and it would contradict the `connected: true` the same row carries. The
  // closed vocabulary this projection publishes stays closed either way.
  return state === "unknown" ? "connected" : state;
}
