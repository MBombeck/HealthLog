"use client";

/**
 * Dashboard banner for an admin while the recovery kit is due: never
 * confirmed, or listing a key the confirmation does not cover (a rotation, a
 * new backup key). Not dismissable by design: it goes away when the kit is
 * confirmed, and comes back when a key changes. Renders nothing for anyone
 * who is not an admin, and asks the server nothing for them either.
 *
 * 1.50: "Later" in the server setup's kit step sets a never-confirmed kit
 * aside for seven days, then the banner is back. A kit that is due because
 * a key changed after a confirmation shows at once, whatever was answered.
 */

import Link from "next/link";
import { KeyRound } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { useRecoveryKit } from "@/components/admin/use-recovery-kit";
import { InlineAction } from "@/components/ui/inline-action";
import { useState } from "react";
import { useServerSetup } from "@/lib/queries/use-server-setup";

/** How long "Later" in the setup's kit step keeps the banner away. */
const LATER_MS = 7 * 24 * 60 * 60 * 1000;

export function RecoveryKitBanner({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslations();
  const { data } = useRecoveryKit(isAdmin);
  const setup = useServerSetup({ enabled: isAdmin });
  // Read once per page: whether the week has passed does not change under it.
  const [now] = useState(() => Date.now());
  if (!isAdmin || !data?.due) return null;
  const passed = setup.data?.steps.find((step) => step.id === "recovery");
  const setAside =
    data.confirmedAt === null &&
    passed?.status === "skipped" &&
    passed.at !== undefined &&
    now - new Date(passed.at).getTime() < LATER_MS;
  if (setup.isLoading || setAside) return null;
  return (
    <div
      role="status"
      data-testid="recovery-kit-banner"
      className="border-warning/40 bg-warning/10 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center"
    >
      <KeyRound className="text-warning h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="flex-1 space-y-1">
        <p className="text-sm font-semibold">
          {t("dashboard.recoveryKitBanner.title")}
        </p>
        <p className="text-sm">{t("dashboard.recoveryKitBanner.body")}</p>
      </div>
      <InlineAction asChild size="sm" className="font-medium">
        <Link href="/admin/encryption">
          {t("dashboard.recoveryKitBanner.action")}
        </Link>
      </InlineAction>
    </div>
  );
}
