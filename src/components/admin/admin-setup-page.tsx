"use client";

import Link from "next/link";
import { Compass } from "lucide-react";

import { AdminShell } from "@/components/admin/admin-shell";
import {
  INSTANCE_TASK_ROWS,
  isSettled,
  SetupTaskRow,
} from "@/components/onboarding/setup-task-rows";
import { useSetupState } from "@/components/onboarding/use-setup-state";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { InlineAction } from "@/components/ui/inline-action";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";

/** The page body: the instance's setup rows from `GET /api/setup`. */
export function AdminSetupPage() {
  const { t } = useTranslations();
  const setup = useSetupState();
  const instance = setup.data?.instance ?? null;
  const tasks = instance?.tasks ?? [];
  const decided = tasks.filter(isSettled).length;

  return (
    <AdminShell active="system-status" title={t("setup.admin.title")}>
      {setup.isError ? (
        <QueryErrorRow
          error={setup.error}
          message={t("setup.admin.loadError")}
          onRetry={() => void setup.refetch()}
        />
      ) : !setup.data ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : instance ? (
        <SettingsCard flush data-slot="admin-setup">
          <div className="border-border border-b px-4 py-4 md:px-6">
            <SettingsCardHeader
              icon={Compass}
              title={t("setup.admin.cardTitle")}
              description={t("setup.admin.progress", {
                done: decided,
                total: tasks.length,
              })}
            />
            {instance.status === "pending" ? (
              <p className="mt-2 text-sm">
                <InlineAction asChild size="sm">
                  <Link href="/onboarding/server">
                    {t("setup.admin.resume")}
                  </Link>
                </InlineAction>
              </p>
            ) : null}
          </div>
          <ul className="divide-border divide-y">
            {tasks.map((task) => {
              const row = INSTANCE_TASK_ROWS[task.id];
              return (
                <SetupTaskRow
                  key={task.id}
                  task={task}
                  kind="instance"
                  href={row.href}
                  Icon={row.Icon}
                  returnTo="/admin/setup"
                />
              );
            })}
          </ul>
        </SettingsCard>
      ) : null}
    </AdminShell>
  );
}
