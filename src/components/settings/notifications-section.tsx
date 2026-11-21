"use client";

import Link from "next/link";
import { Bell, BellRing, ChevronRight, Smartphone } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { isSurfaceVisible } from "@/lib/modules/surface";
import { CoachNudgeCard } from "@/components/settings/coach-nudge-card";
import { DoseSnoozeCard } from "@/components/settings/dose-snooze-card";
import { LowStockCard } from "@/components/settings/low-stock-card";
import { SectionHeading } from "@/components/ui/section-heading";
import { MoodReminderCard } from "@/components/settings/mood-reminder-card";
import { NotificationContentCard } from "@/components/settings/notification-content-card";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { VorsorgeReminderSwitchesCard } from "@/components/measurement-reminders/vorsorge-settings";
import { Button } from "@/components/ui/button";
import { InlineAction } from "@/components/ui/inline-action";

/**
 * `<NotificationsSection>` — Settings → Notifications ("Benachrichtigungen").
 *
 * The one home for every reminder kind. A reminder whose settings belong to
 * one place is set here; a reminder that is set where its subject lives (a
 * medication's dose times on the medication, the cycle reminders in the
 * per-event matrix) gets a row here that says where, so nothing has to be
 * found by luck.
 *
 * Each card is shown only while its module is on, read from the resolved
 * `useAuth().user.modules` map and failing open, so a stale `/me` payload
 * never blanks a card.
 *
 * v1.18.0 — the separate "Erinnerungen" hub is gone; `/settings/reminders`
 * redirects here. v1.25.7 — the delivery channels live under Integrations
 * (they are delivery providers); `/settings/channels` redirects there and this
 * page links to them. v1.44 — the Coach nudges came back from Settings > Coach
 * and the checkup reminder switches from the checkups arrangement page; both
 * old places link here (`/settings/coach#coach-nudge` forwards).
 */
export function NotificationsSection() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  // The Coach gate reads the surface map like the Coach section does, after
  // hydration, so the server render and the first client paint agree.
  const mounted = useMounted();

  const moodEnabled = user?.modules?.mood !== false;
  const medsEnabled = user?.modules?.medications !== false;
  const cycleEnabled = user?.modules?.cycle !== false;
  const coachEnabled =
    !mounted || isSurfaceVisible("settings:coach", user?.modules);

  return (
    <div className="space-y-10">
      {/* Group 1 — Reminders ("what you receive"). The checkup reminders are
          not a module and always show, so the group always has content. */}
      <section className="space-y-4">
        <SectionHeading
          icon={Bell}
          title={t("settings.sections.notifications.remindersHeading")}
        />

        {moodEnabled ? (
          <div id="mood-reminder" className="scroll-mt-28">
            <MoodReminderCard isAuthenticated={isAuthenticated} />
          </div>
        ) : null}

        {medsEnabled ? (
          <div id="dose-snooze" className="scroll-mt-28">
            <DoseSnoozeCard isAuthenticated={isAuthenticated} />
          </div>
        ) : null}

        {medsEnabled ? (
          <div id="low-stock" className="scroll-mt-28">
            <LowStockCard isAuthenticated={isAuthenticated} />
          </div>
        ) : null}

        {coachEnabled ? (
          <div id="coach-nudge" className="scroll-mt-28">
            <CoachNudgeCard isAuthenticated={isAuthenticated} />
          </div>
        ) : null}

        <div id="vorsorge-reminders" className="scroll-mt-28">
          <VorsorgeReminderSwitchesCard />
        </div>

        {/* Reminders set where their subject lives. One row each, saying
            where; nothing here writes. */}
        {medsEnabled || cycleEnabled ? (
          <SettingsCard data-slot="notifications-elsewhere">
            <SettingsCardHeader
              anchor="other-reminders"
              icon={BellRing}
              title={t("settings.sections.notifications.elsewhere.title")}
              description={t(
                "settings.sections.notifications.elsewhere.description",
              )}
            />
            <ul className="divide-border divide-y">
              {medsEnabled ? (
                <li className="space-y-1 py-3 first:pt-0">
                  <p className="text-sm font-medium">
                    {t("settings.sections.notifications.elsewhere.doses.title")}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t(
                      "settings.sections.notifications.elsewhere.doses.description",
                    )}
                  </p>
                  <InlineAction asChild tone="muted">
                    <Link href="/medications">
                      {t(
                        "settings.sections.notifications.elsewhere.doses.link",
                      )}
                      <ChevronRight className="size-3.5" aria-hidden="true" />
                    </Link>
                  </InlineAction>
                </li>
              ) : null}
              {cycleEnabled ? (
                <li
                  id="cycle-reminders"
                  className="scroll-mt-28 space-y-1 py-3 first:pt-0"
                >
                  <p className="text-sm font-medium">
                    {t("settings.sections.notifications.elsewhere.cycle.title")}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t(
                      "settings.sections.notifications.elsewhere.cycle.description",
                    )}
                  </p>
                  <InlineAction asChild tone="muted">
                    <Link href="/notifications">
                      {t(
                        "settings.sections.notifications.elsewhere.cycle.link",
                      )}
                      <ChevronRight className="size-3.5" aria-hidden="true" />
                    </Link>
                  </InlineAction>
                </li>
              ) : null}
            </ul>
          </SettingsCard>
        ) : null}
      </section>

      {/* Group 2 — How notifications look on the phone. Not module-gated:
          it applies to every notification the account receives. */}
      <section className="space-y-4">
        <SectionHeading
          icon={Smartphone}
          title={t("settings.sections.notifications.displayHeading")}
        />
        <div id="notification-content" className="scroll-mt-28">
          <NotificationContentCard isAuthenticated={isAuthenticated} />
        </div>
      </section>
      {/* Cross-links to the other two notification surfaces. At the END of
          the page: a screen that opens with two ways off it never says what
          it is for. */}
      <div
        className="flex flex-wrap gap-2"
        data-slot="notifications-crosslinks"
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/notifications">
            {t("settings.sections.notifications.matrixLink")}
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/integrations#channels">
            {t("settings.sections.notifications.channelsLink")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
