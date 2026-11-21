"use client";

/* ────────────────────────────────────────────────────────────────
 * Standing AI consent — the web side of the withdrawal.
 *
 * The revoke endpoint (`DELETE /api/consent/ai/latest?kind=ai_full`) has
 * existed since v1.4.40, but only the native client ever called it: on the
 * web, consent could be given and never taken back. GDPR Art. 7 (3) puts
 * withdrawal on the same footing as the grant, so it belongs on the same
 * surface, not behind a support request.
 *
 * The card renders the standing decision from `ai.consent` on `/api/auth/me`
 * and offers the one move that changes it. While consent stands it says
 * since when and to which service, with the withdraw control. While it does
 * not and the operator's provider needs it, the consent question at the top
 * of the page (`AiConsentRequest`) asks it: the provider, the data, and an
 * "Agree" button that is the consent act. Nothing here grants on mount;
 * until v1.43.2 the page minted a receipt on every visit, which is exactly
 * what this replaced.
 * Withdrawing takes effect immediately: the consent gate fails closed
 * without an active receipt, so every AI surface falls back to its
 * no-consent state on the next call.
 *
 * v1.39 — a withdrawal also deletes what the app can write again: the notes
 * a model wrote from the person's data (status notes, the daily briefing,
 * model-written period summaries, arrival lines, workout notes), in the same
 * step as the revoke. The person's own records stay: Coach conversations,
 * what the Coach remembered, plans and document summaries, readable and
 * deletable by them. The confirm copy says exactly that.
 *
 * The narrower consent for reading documents (`ai_extraction`) gets its own
 * row once one is on file, with its own withdrawal. It is granted where a
 * document is read, so this is where it is taken back.
 * ──────────────────────────────────────────────────────────────── */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useAiConsent } from "@/hooks/use-ai-capability";
import { useAuth } from "@/hooks/use-auth";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";

type ConsentReceiptWire = {
  id: string;
  kind: string;
  signedAt: string;
  revokedAt: string | null;
} | null;

export function AiConsentCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  // The standing decision comes off the account payload, resolved on the
  // server with the capabilities it governs, so this card and every AI
  // surface agree on it. `null` until `/me` has answered.
  const consent = useAiConsent();
  const { isLoading: authLoading } = useAuth();

  const revoke = useMutation({
    mutationKey: queryKeys.aiConsentReceipt("ai_full"),
    mutationFn: async () => {
      const res = await apiFetchRaw("/api/consent/ai/latest?kind=ai_full", {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("revoke failed");
    },
    onSuccess: async () => {
      setConfirming(false);
      // The receipt gates every AI surface, so anything that reads consent
      // state has to re-resolve — not just this card. `/me` carries the
      // resolved capabilities and the consent state every AI surface
      // renders from.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.aiConsentReceipt("ai_full"),
      });
      await invalidateKeys(queryClient, aiInputDependentKeys);
    },
  });

  if (!isAuthenticated) return null;

  // Say nothing until the state is known: a card that flashes the question
  // before the payload arrives would misreport the person's own decision.
  // But hold the block's space with a skeleton mirroring the final shape, so
  // nothing below moves once it lands.
  if (consent === null && authLoading) {
    return (
      <SettingsCard as="section" data-slot="ai-consent">
        <SettingsCardHeader
          anchor="ai-consent"
          icon={ShieldCheck}
          title={t("settings.ai.consent.title")}
          description={<Skeleton className="h-4 w-56" />}
        />
        <Skeleton className="ml-auto h-8 w-32" />
      </SettingsCard>
    );
  }

  // Not given: nothing to withdraw. Where agreeing would open something (the
  // operator's provider) the question sits at the top of this page
  // (`AiConsentRequest`); a person on their own key or a local model has
  // nothing to agree to, and reading documents asks its own narrower question
  // where a document is read.
  if (consent === null || consent.status !== "given") {
    return <DocumentReadingConsentRow isAuthenticated={isAuthenticated} />;
  }

  const providers = consent.recipients.map((r) => r.name).join(", ");
  const description = consent.since
    ? providers
      ? t("settings.ai.consent.activeSinceNamed", {
          date: fmt.dateTime(consent.since),
          providers,
        })
      : t("settings.ai.consent.activeSince", {
          date: fmt.dateTime(consent.since),
        })
    : t("settings.ai.consent.activeUndated");

  return (
    <>
      <SettingsCard as="section" data-slot="ai-consent">
        <SettingsCardHeader
          anchor="ai-consent"
          icon={ShieldCheck}
          title={t("settings.ai.consent.title")}
          description={description}
        />

        {confirming ? (
          <p className="text-foreground text-sm">
            {t("settings.ai.consent.confirmBody")}
          </p>
        ) : null}

        {revoke.isError ? (
          <p className="text-destructive text-xs" role="alert">
            {t("settings.ai.consent.error")}
          </p>
        ) : null}

        {/* One action row, last in the card; while confirming, Cancel sits
            before the destructive confirm (design standards §12). */}
        <SettingsCardActions>
          {confirming ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                onClick={() => setConfirming(false)}
                disabled={revoke.isPending}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="min-h-11 sm:min-h-9"
                data-slot="ai-consent-withdraw-confirm"
                onClick={() => revoke.mutate()}
                disabled={revoke.isPending}
              >
                {revoke.isPending ? (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                ) : null}
                {t("settings.ai.consent.confirmWithdraw")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              data-slot="ai-consent-withdraw"
              onClick={() => setConfirming(true)}
            >
              {t("settings.ai.consent.withdraw")}
            </Button>
          )}
        </SettingsCardActions>
      </SettingsCard>

      <DocumentReadingConsentRow isAuthenticated={isAuthenticated} />
    </>
  );
}

/**
 * The consent for reading documents (`ai_extraction`), shown only while one
 * is on file. Withdrawing it stops documents, lab report scans and medication
 * text from being sent for reading at once; it deletes nothing, because what
 * a read produced (a document summary, extracted values) is the person's own
 * record.
 */
function DocumentReadingConsentRow({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const { data } = useQuery({
    queryKey: queryKeys.aiConsentReceipt("ai_extraction"),
    queryFn: async () => {
      const res = await apiFetchRaw(
        "/api/consent/ai/latest?kind=ai_extraction",
      );
      if (!res.ok) return null;
      const json = await res.json();
      return (json.data?.receipt ?? null) as ConsentReceiptWire;
    },
    enabled: isAuthenticated,
  });

  const revoke = useMutation({
    mutationKey: queryKeys.aiConsentReceipt("ai_extraction"),
    mutationFn: async () => {
      const res = await apiFetchRaw(
        "/api/consent/ai/latest?kind=ai_extraction",
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("revoke failed");
    },
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.aiConsentReceipt("ai_extraction"),
      });
      await invalidateKeys(queryClient, aiInputDependentKeys);
    },
  });

  const active = data && data.revokedAt === null ? data : null;
  if (!active) return null;

  return (
    <SettingsCard as="section" data-slot="ai-consent-document-reading">
      <SettingsCardHeader
        icon={ShieldCheck}
        title={t("settings.ai.consent.documentReading.title")}
        description={t("settings.ai.consent.documentReading.activeSince", {
          date: fmt.dateTime(active.signedAt),
        })}
      />
      {confirming ? (
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.consent.documentReading.confirmBody")}
        </p>
      ) : null}
      {revoke.isError ? (
        <p className="text-destructive text-xs" role="alert">
          {t("settings.ai.consent.error")}
        </p>
      ) : null}
      <SettingsCardActions>
        {confirming ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              onClick={() => setConfirming(false)}
              disabled={revoke.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="min-h-11 sm:min-h-9"
              data-slot="ai-consent-document-reading-withdraw-confirm"
              onClick={() => revoke.mutate()}
              disabled={revoke.isPending}
            >
              {revoke.isPending ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("settings.ai.consent.confirmWithdraw")}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            data-slot="ai-consent-document-reading-withdraw"
            onClick={() => setConfirming(true)}
          >
            {t("settings.ai.consent.withdraw")}
          </Button>
        )}
      </SettingsCardActions>
    </SettingsCard>
  );
}
