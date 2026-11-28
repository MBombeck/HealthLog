"use client";

import Link from "next/link";
import { useState } from "react";
import { ShieldAlert, X } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { useServerSetup } from "@/lib/queries/use-server-setup";

/**
 * How long before the date the strip shows for an owner who answered the
 * setup's second-factor step with "Later" (1.50). Everyone else sees it for
 * the whole grace period.
 */
const LATER_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * The grace-period prompt of the second-factor policy
 * (`@/lib/auth/mfa-enrollment`): while an account a policy covers still has
 * time, this strip says by when it has to add a factor and where. After the
 * date the server confines the session to the enrolment surface, so the strip
 * has nothing left to say and the proxy shows `/enroll-mfa` instead.
 *
 * Hidden for the rest of the page's life when dismissed; it comes back on the
 * next load, because the date does not move.
 *
 * One exception (1.50): the owner who passed the server setup's
 * second-factor step with "Later" answered this already, so for them the
 * strip waits until the last 72 hours before the date (or the whole grace
 * period, when it is shorter). It waits only for that answer, given by this
 * account, never for a pass the setup inferred.
 */
export function MfaEnrollmentBanner() {
  const { user } = useAuth();
  const { t } = useTranslations();
  const format = useFormatters();
  const [dismissed, setDismissed] = useState(false);
  // Read once per page: the strip is a page-life decision, like its dismissal.
  const [now] = useState(() => Date.now());

  const enrollment = user?.mfaEnrollment;
  const inGrace = enrollment?.state === "grace" && Boolean(enrollment.dueAt);
  const setup = useServerSetup({ enabled: inGrace && user?.role === "ADMIN" });
  if (dismissed || !inGrace || !enrollment?.dueAt || setup.isLoading) {
    return null;
  }
  const passedLater = setup.data?.steps.some(
    (step) =>
      step.id === "account-mfa" &&
      step.status === "skipped" &&
      step.by === user?.id,
  );
  if (
    passedLater &&
    new Date(enrollment.dueAt).getTime() - now > LATER_WINDOW_MS
  ) {
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
