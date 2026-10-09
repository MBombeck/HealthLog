"use client";

import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useAccountSwitch } from "@/hooks/use-account-switch";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.36.0 — the page a delegate reached that sharing does not cover.
 *
 * The nav drops these destinations while a switch is on, so the way here is a
 * bookmark, a browser back button, or a link somebody kept open. Without this
 * panel the page would mount, fire its reads, collect a row of 403s, and paint
 * a screen full of error cards that each say something went wrong — when
 * nothing did.
 *
 * It says the honest thing instead: this surface is not part of what sharing
 * covers, and here is the way back to your own record. Settings, credentials,
 * integrations, notification channels and the AI surfaces are the account
 * around a health record rather than the record itself; a delegate reads the
 * record.
 *
 * Paint, not enforcement. Every route behind these pages refuses on its own,
 * from a frozen allowlist this component cannot reach — if this file were
 * deleted the delegate would see 403s, not data.
 */
export function SharedRecordUnavailable() {
  const { t } = useTranslations();
  const switchAccount = useAccountSwitch();

  return (
    <div data-slot="shared-record-unavailable" className="py-10">
      <EmptyState
        icon={<Lock className="size-6" />}
        title={t("recordSharing.unavailable.title")}
        description={t("recordSharing.unavailable.description")}
        action={
          <Button
            data-slot="shared-record-unavailable-leave"
            disabled={switchAccount.isPending}
            onClick={() => switchAccount.mutate(null)}
          >
            {t("recordSharing.unavailable.leave")}
          </Button>
        }
      />
    </div>
  );
}
