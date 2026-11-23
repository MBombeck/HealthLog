"use client";

/**
 * v1.18.0 — Settings → Coach.
 *
 * The Coach preference cards moved out of the AI / Assistant section into
 * their own dedicated entry so the AI section owns only provider / model /
 * BYOK configuration. This section gathers the Coach-specific surface:
 *
 *   1. Coach state       — on or off, with a link to the one switch in
 *                          Settings > Modules (v1.44: the second switch that
 *                          used to sit here is gone; kept first so a person
 *                          who wants the surface gone finds the way at once).
 *   2. Coach preferences — tone, verbosity, data scope (`useCoachPrefs`).
 *   3. Proactive nudges  — a pointer to Settings > Notifications, where the
 *                          nudge card lives with the other reminders since
 *                          v1.44 (`#coach-nudge` forwards there).
 *   4. Coach memory      — durable-fact review + forget controls.
 *
 * The nav entry is module-gated on `coach`. The preference + nudge cards
 * keep their own content gate on the same published module state
 * (`user.modules.coach`, resolved by the server for the record on screen
 * from that record's opt-out and the operator's switches): hiding the Coach
 * hides its tuning. The raw `disableCoach` column is the signed-in person's
 * own, so inside a managed or shared record it answered for the wrong
 * person. The memory (facts, stored conversations and reminders) is never
 * gated: it is the person's own record, readable and deletable whatever the
 * Coach's state. The reminders card turns read-only while the Coach is
 * unavailable and, with the Coach hidden, shows only when rows exist.
 *
 * The "about me" context lives in the AI section, not here — the daily
 * briefing reads it too, so it is not a Coach-only setting.
 *
 * v1.18.6 — the visible heading + subtitle now come from the shared
 * `<SettingsSectionFrame>` in the route; this body is the Coach cards only.
 */

import Link from "next/link";
import { BellRing, ChevronRight, MessageCircleHeart } from "lucide-react";

import { CoachMemorySection } from "@/components/settings/coach-memory-section";
import { CoachConversationsMemoryCard } from "@/components/settings/coach-conversations-memory-card";
import { CoachRemindersSection } from "@/components/settings/coach-reminders-section";
import { CoachPlansMemoryCard } from "@/components/settings/coach-plans-memory-card";
import { ModuleStateCard } from "@/components/settings/module-state-card";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { CoachPrefsSection } from "@/components/settings/coach-prefs-section";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useModuleEnabledState } from "@/hooks/use-module-toggle";
import { useTranslations } from "@/lib/i18n/context";
import { isSurfaceVisible } from "@/lib/modules/surface";

export function CoachSection() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  // The same reading the Modules switch shows, so both say one thing.
  const moduleSwitchState = useModuleEnabledState();
  // Mirror the AI section's hydration-safe gating: the auth query can
  // resolve before this boundary hydrates, so gate the child props on
  // `useMounted()` to keep the hydration render matching the SSR HTML.
  const mounted = useMounted();
  const authed = mounted && isAuthenticated;
  // The preference + nudge cards ride the same content gate as the rest of
  // the Coach surface: when the record has the Coach hidden there is no
  // assistant to tune. Read from the server's module map for the record,
  // never recomputed from the account's own columns. (`mounted`-gated so the
  // SSR + hydration renders agree.)
  const coachEnabled =
    !mounted || isSurfaceVisible("settings:coach", user?.modules);

  return (
    <div className="space-y-6">
      {/* Before hydration the state reads on, the default, so the server
          render and the first client paint agree. */}
      <ModuleStateCard
        moduleKey="coach"
        enabled={!mounted || moduleSwitchState("coach")}
        icon={MessageCircleHeart}
        title={t("settings.coach.state.title")}
        description={t("settings.coach.state.description")}
        anchor="coach-activate"
        slot="settings-coach-state-card"
      />

      {coachEnabled && <CoachPrefsSection isAuthenticated={authed} />}

      {/* The proactive nudges are a reminder: set under Notifications with
          the others since v1.44. */}
      {coachEnabled && (
        <SettingsCard data-slot="settings-coach-nudge-link">
          <SettingsCardHeader
            icon={BellRing}
            title={t("notifications.coachNudge.title")}
            description={t("settings.coach.nudgesMoved")}
          />
          <SettingsCardActions align="start">
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/notifications#coach-nudge">
                {t("settings.coach.openNudges")}
                <ChevronRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
          </SettingsCardActions>
        </SettingsCard>
      )}

      <CoachMemorySection isAuthenticated={authed} />

      <CoachConversationsMemoryCard isAuthenticated={authed} />

      <CoachPlansMemoryCard isAuthenticated={authed} />

      <CoachRemindersSection
        isAuthenticated={authed}
        hideWhenEmpty={!coachEnabled}
      />
    </div>
  );
}
