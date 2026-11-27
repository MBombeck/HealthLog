"use client";

import { useState } from "react";

import { TileHeader } from "@/components/insights/tile-header";
import {
  isSettled,
  PERSON_TASK_ROWS,
  SETUP_CARD_ICON,
  SetupTaskRow,
} from "@/components/onboarding/setup-task-rows";
import { useSetupCardDismissal } from "@/components/onboarding/use-setup-state";
import { Card } from "@/components/ui/card";
import { InlineAction } from "@/components/ui/inline-action";
import { useTranslations } from "@/lib/i18n/context";
import type { SetupStateDto } from "@/lib/setup/types";
import { showErrorToast } from "@/lib/errors/error-toast";
import { localizedApiError } from "@/lib/api/localized-error";

/**
 * "Finish setting up" on the dashboard (1.50): the rows the setup flow left
 * open, each a link to where it is done, detected from the domain so a row
 * completes however it was done. Done rows fold away behind "Show the n
 * done"; "Hide this card" is kept on the server, and Settings › Account ›
 * Setup lists the same rows. The one setup surface on the dashboard.
 */
export function SetupCard({ state }: { state: SetupStateDto }) {
  const { t } = useTranslations();
  const dismissal = useSetupCardDismissal();
  const [showDone, setShowDone] = useState(false);
  const tasks = state.person.tasks;
  const done = tasks.filter(isSettled);
  const visible = showDone ? tasks : tasks.filter((row) => !isSettled(row));

  return (
    <Card className="gap-0 py-0 md:gap-0 md:py-0" data-slot="setup-card">
      <div className="border-border border-b px-4 py-4 md:px-6">
        <TileHeader
          icon={SETUP_CARD_ICON}
          title={t("setup.card.title")}
          right={
            <span className="text-muted-foreground text-sm tabular-nums">
              {t("setup.card.progress", {
                done: done.length,
                total: tasks.length,
              })}
            </span>
          }
        />
      </div>
      <ul className="divide-border divide-y">
        {visible.map((task) => {
          const row = PERSON_TASK_ROWS[task.id];
          return (
            <SetupTaskRow
              key={task.id}
              task={task}
              kind="person"
              href={row.href}
              Icon={row.Icon}
            />
          );
        })}
      </ul>
      <div className="border-border flex items-center justify-between gap-3 border-t px-4 py-3 md:px-6">
        {done.length > 0 ? (
          <InlineAction
            size="sm"
            onClick={() => setShowDone((value) => !value)}
            data-slot="setup-card-toggle-done"
          >
            {showDone
              ? t("setup.card.hideDone")
              : t("setup.card.showDone", { count: done.length })}
          </InlineAction>
        ) : (
          <span aria-hidden="true" />
        )}
        <InlineAction
          tone="muted"
          size="sm"
          disabled={dismissal.isPending}
          onClick={() =>
            dismissal.mutate(true, {
              onError: (err) =>
                showErrorToast(
                  localizedApiError(err, t, "onboarding.errorGeneric"),
                  { cause: err },
                ),
            })
          }
          data-slot="setup-card-hide"
        >
          {t("setup.card.hide")}
        </InlineAction>
      </div>
    </Card>
  );
}
