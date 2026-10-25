"use client";

/**
 * Dashboard banner for an admin while the recovery kit is due: never
 * confirmed, or listing a key the confirmation does not cover (a rotation, a
 * new backup key). Not dismissable by design: it goes away when the kit is
 * confirmed, and comes back when a key changes. Renders nothing for anyone
 * who is not an admin, and asks the server nothing for them either.
 */

import Link from "next/link";
import { KeyRound } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { useRecoveryKit } from "@/components/admin/use-recovery-kit";
import { InlineAction } from "@/components/ui/inline-action";

export function RecoveryKitBanner({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslations();
  const { data } = useRecoveryKit(isAdmin);
  if (!isAdmin || !data?.due) return null;
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
      <InlineAction asChild size="sm" className="min-h-11 font-medium">
        <Link href="/admin/encryption">
          {t("dashboard.recoveryKitBanner.action")}
        </Link>
      </InlineAction>
    </div>
  );
}
