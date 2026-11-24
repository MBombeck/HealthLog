/**
 * The operator's one answer to "Use the HealthLog push relay?", for the whole
 * server (`AppSettings.pushRelayDecision`).
 *
 * The answer is not a second switch beside the relay's: it is written by the
 * same code that turns the relay on and off (`registration.ts`). `on` is
 * stored only once a registration at the relay succeeded, `off` when an admin
 * answered no or switched the relay off. Nothing stored means nobody answered.
 *
 * What is published (`operatorDecisionOf`):
 * - `on`: this server is registered at the relay (a registration with an
 *   instance id), whatever the column says, because that registration is
 *   what `routeFor` sends by. The column and the registration can disagree
 *   only when something other than the switch wrote the column, and a
 *   restore of instance settings is that something: the registration never
 *   travels, so a file from before the relay was switched on carries `null`
 *   or `off` while the relay runs. The restore keeps the host's answer then
 *   (`restoreAppSettings`); this rule is what holds should anything else
 *   ever write the column. Also `on`: the answer was yes and a registration
 *   is there that is not finished yet.
 * - `off`: the answer was no, or there is nothing to decide. A server whose
 *   relay is not available (`PUSH_RELAY_MODE=off`, no pinned relay keys) or
 *   that has an APNs key of its own never routes a push over the relay
 *   (`routeFor`), so asking its admin would be a question without a
 *   consequence.
 * - `undecided`: everything else, which is the only state an admin is asked
 *   in. A stored `on` without a registration (a restore onto a new host, which
 *   does not carry the registration) reads as undecided, so the admin is asked
 *   again rather than told the relay is on when it is not. A stored `off` is
 *   never asked again.
 */
import { prisma } from "@/lib/db";

export const RELAY_OPERATOR_DECISIONS = ["undecided", "on", "off"] as const;
export type RelayOperatorDecision = (typeof RELAY_OPERATOR_DECISIONS)[number];

/** What the column holds (CHECK in migration 0556). */
export type StoredRelayDecision = "on" | "off" | null;

export function storedRelayDecisionOf(
  value: string | null | undefined,
): StoredRelayDecision {
  return value === "on" || value === "off" ? value : null;
}

export function operatorDecisionOf(input: {
  stored: StoredRelayDecision;
  /** A registration for the configured relay exists (`offered`). */
  offered: boolean;
  /**
   * That registration has an instance id: this server is registered at the
   * relay and `routeFor` sends over it.
   */
  registered: boolean;
  /** The relay is available on this server (`relayConfig().available`). */
  available: boolean;
  /** This server has an APNs key of its own. */
  apnsConfigured: boolean;
}): RelayOperatorDecision {
  if (input.registered) return "on";
  if (input.offered && input.stored === "on") return "on";
  if (input.stored === "off") return "off";
  if (!input.available || input.apnsConfigured) return "off";
  return "undecided";
}

export async function loadStoredRelayDecision(): Promise<StoredRelayDecision> {
  const row = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { pushRelayDecision: true },
  });
  return storedRelayDecisionOf(row?.pushRelayDecision);
}

/** Store the answer. Called by the relay's own on and off paths only. */
export async function recordRelayDecision(decision: "on" | "off") {
  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", pushRelayDecision: decision },
    update: { pushRelayDecision: decision },
  });
}
