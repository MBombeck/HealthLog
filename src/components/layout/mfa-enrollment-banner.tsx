"use client";

import Link from "next/link";
import { useState } from "react";
import { ShieldAlert, X } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

/**
 * The grace-period prompt of the second-factor policy
 * (`@/lib/auth/mfa-enrollment`): while an account a policy covers still has
 * time, this strip says by when it has to add a factor and where. After the
 * date the server confines the session to the enrolment surface, so the strip
 * has nothing left to say and the proxy shows `/enroll-mfa` instead.
 *
 * Hidden for the rest of the page's life when dismissed; it comes back on the
 * next load, because the date does not move.
 */
export function MfaEnrollmentBanner() {
  const { user } = useAuth();
  const { t } = useTranslations();
  const format = useFormatters();
  const [dismissed, setDismissed] = useState(false);

  const enrollment = user?.mfaEnrollment;
  if (dismissed || enrollment?.state !== "grace" || !enrollment.dueAt) {
    return null;
  }
  const date = format.date(new Date(enrollment.dueAt));

  return (
    <div
      role="status"
      data-slot="mfa-enrollment-banner"
      className="bg-warning/15 border-warning/40 flex items-start gap-3 border-b px-3 py-2 text-xs sm:items-center"
    >
      <ShieldAlert
        className="text-foreground mt-0.5 size-3.5 shrink-0 sm:mt-0"
        aria-hidden="true"
      />
      <p className="text-foreground min-w-0 flex-1 leading-snug">
        {t("auth.enrollMfa.graceBanner", { date })}{" "}
        <Link href="/settings/security" className="font-medium underline">
          {t("auth.enrollMfa.graceAction")}
        </Link>
      </p>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={t("auth.enrollMfa.graceDismiss")}
        className="text-muted-foreground hover:text-foreground shrink-0"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
