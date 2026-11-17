"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowRight } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { InlineAction } from "@/components/ui/inline-action";
import { apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

/**
 * The note an account that had Fitbit connected finds at the top of
 * Settings → Integrations once the integration is gone. Google turned the
 * Fitbit Web API off on 30 October 2026; the note says so, says the imported
 * data stays, and names the two ways to keep Fitbit data coming: the Google
 * Health card on this page and the Health Connect import. The server decides
 * whether it shows (`fitbitRemovalNotice` on the status envelope); dismissing
 * it clears the flag for good.
 */
export function FitbitRemovalNotice() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () =>
      apiPost<{ dismissed: true }>(
        "/api/integrations/fitbit-removal-notice/dismiss",
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      }),
    onError: () => showErrorToast(t("settings.fitbitRemoval.dismissFailed")),
  });
  return (
    <FitbitRemovalNoticeView
      dismissing={dismiss.isPending}
      onDismiss={() => dismiss.mutate()}
    />
  );
}

/** The note itself, without the request behind the dismiss button. */
export function FitbitRemovalNoticeView({
  dismissing,
  onDismiss,
}: {
  dismissing: boolean;
  onDismiss: () => void;
}) {
  const { t } = useTranslations();
  return (
    <section
      role="note"
      aria-labelledby="fitbit-removal-notice-title"
      data-testid="fitbit-removal-notice"
      className="border-border bg-muted/40 text-foreground space-y-2 rounded-md border px-4 py-3 text-sm"
    >
      <h3 id="fitbit-removal-notice-title" className="font-medium">
        {t("settings.fitbitRemoval.title")}
      </h3>
      <p>{t("settings.fitbitRemoval.body")}</p>
      <p>{t("settings.fitbitRemoval.ways")}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
        <InlineAction asChild size="sm">
          <a href="#google-health" data-testid="fitbit-removal-to-google">
            {t("settings.fitbitRemoval.toGoogleHealth")}
            <ArrowDown className="size-3" aria-hidden="true" />
          </a>
        </InlineAction>
        <InlineAction asChild size="sm">
          <Link
            href="/settings/export#import-health-connect"
            data-testid="fitbit-removal-to-health-connect"
          >
            {t("settings.fitbitRemoval.toHealthConnect")}
            <ArrowRight className="size-3" aria-hidden="true" />
          </Link>
        </InlineAction>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto min-h-11 sm:min-h-9"
          disabled={dismissing}
          onClick={onDismiss}
          data-testid="fitbit-removal-dismiss"
        >
          {t("settings.fitbitRemoval.dismiss")}
        </Button>
      </div>
    </section>
  );
}
