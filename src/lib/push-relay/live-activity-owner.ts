/**
 * Who started a registered Live Activity, which relay events it may take,
 * and which relay-started ones an app-started Activity of the same dose
 * makes redundant. Pure: no database, no send.
 */
import { activityShowsDose } from "@/lib/push-relay/activity-slot";

/**
 * Who started a registered Activity: the relay, by a push-to-start
 * (`HealthLogDoseAttributes`, registered with `relayStart: true`, the dose
 * the device's `liveActivityStarted` names), or the app itself
 * (`MedicationActivityAttributes`). The mark is kept per token
 * (`relayStarted`, migration 0545) and never changes for an Activity.
 */
export type RelayActivityKind = "relay_started" | "app_started";

export function relayActivityKind(activity: {
  relayStarted: boolean;
}): RelayActivityKind {
  return activity.relayStarted ? "relay_started" : "app_started";
}

/**
 * The relay-started Activities that show a dose an app-started Activity of
 * the same device shows too, matched by {@link activityShowsDose}, the
 * match the start and the end path make.
 *
 * One owner per dose. iOS builds up to 1.7 start their own Activity for a
 * dose whatever the relay started, so a relay start that came first stands
 * beside the app's own one, which alone has the Take button. The relay one
 * ends and the app's stays. The dose stays held by its start row
 * (`doseStartHeld`), so no second relay start follows. From the next 1.7 build the app starts none of its own while a
 * relay Activity runs for the dose, and the relay Activity gets a Take
 * button of its own.
 */
export function supersededRelayActivities<
  T extends {
    medicationId: string | null;
    slotInstant: Date | null;
    relayStarted: boolean;
  },
>(activities: readonly T[]): T[] {
  const appStarted = activities.filter(
    (a) => relayActivityKind(a) === "app_started",
  );
  return activities.filter((relay) => {
    const { medicationId, slotInstant: slot } = relay;
    return (
      relayActivityKind(relay) === "relay_started" &&
      medicationId !== null &&
      slot !== null &&
      appStarted.some((app) => activityShowsDose(app, medicationId, slot))
    );
  });
}

/**
 * Whether the relay may send `event` to a registered Activity of this kind.
 * Every relay update is built through {@link relayUpdateItem}, which asks
 * this; the end path (`endActivitiesOverRelay`) ends every kind.
 *
 * An end goes to both kinds: the relay writes its own fixed content state
 * into an end (`status: "taken"`, `countdownTarget: 0`, a `dismissal-date`
 * of now; the server may send no state with it), and both attributes types
 * hide the countdown for a taken dose and dismiss at once.
 *
 * An update goes only to an Activity the relay started. The relay template
 * carries `countdownTarget` in unix seconds, which `HealthLogDoseAttributes`
 * reads; `MedicationActivityAttributes` reads it as seconds since
 * 2001-01-01, so an update showed an app-started Activity a time 31 years
 * off. The relay's bounds (one day back, two days ahead of its clock, or 0)
 * leave no room to send it reference-date seconds instead. iOS builds before
 * the next 1.7 build read app-started Activities in reference-date seconds;
 * relaxing this waits until those builds are gone (1.50 at the earliest).
 */
export function relayEventAllowed(
  kind: RelayActivityKind,
  event: "update" | "end",
): boolean {
  return event === "end" || kind === "relay_started";
}
