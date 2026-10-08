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
 * The card shows the standing decision in plain words and offers the one
 * move that changes it: withdraw while consent stands, grant while it does
 * not. Withdrawing takes effect immediately: the consent gate fails closed
 * without an active receipt, so every AI surface falls back to its
 * no-consent state on the next call. Granting posts an affirmative intent,
 * which is the consent act itself and therefore may supersede an earlier
 * revocation; the silent mount heal never does.
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
import { Loader2, ShieldCheck, ShieldOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
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
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.aiConsentReceipt("ai_full"),
    queryFn: async () => {
      const res = await apiFetchRaw("/api/consent/ai/latest?kind=ai_full");
      // A failed read is not a withdrawal: throw so the card says it could
      // not load instead of reporting the person's decision wrongly.
      if (!res.ok) throw new Error("consent read failed");
      const json = await res.json();
      return (json.data?.receipt ?? null) as ConsentReceiptWire;
    },
    enabled: isAuthenticated,
  });

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
      // resolved capabilities every AI surface renders from.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.aiConsentReceipt("ai_full"),
      });
      await invalidateKeys(queryClient, aiInputDependentKeys);
    },
  });

  const grant = useMutation({
    mutationKey: queryKeys.aiConsentReceipt("ai_full"),
    mutationFn: async () => {
      // The affirmative intent marks this as the user's own consent act,
      // the only web path that may lift a standing revocation. The silent
      // mount heal posts no body and cannot.
      const res = await apiFetchRaw("/api/consent/ai/web", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "affirmative" }),
      });
      if (!res.ok) throw new Error("grant failed");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.aiConsentReceipt("ai_full"),
      });
      await invalidateKeys(queryClient, aiInputDependentKeys);
    },
  });

  if (!isAuthenticated) return null;

  // Say nothing until the state is known: a card that flashes "withdrawn"
  // before the receipt arrives would misreport the user's own decision.
  // But hold the block's space with a skeleton mirroring the final shape —
  // returning null here made the section pop in and shift everything
  // below it once the receipt arrived.
  if (isLoading) {
    return (
      <SettingsCard as="section" data-slot="ai-consent">
        <SettingsCardHeader
          icon={ShieldCheck}
          title={t("settings.ai.consent.title")}
          description={<Skeleton className="h-4 w-56" />}
        />
        <Skeleton className="ml-auto h-8 w-32" />
      </SettingsCard>
    );
  }

  if (isError) {
    return (
      <SettingsCard as="section" data-slot="ai-consent">
        <SettingsCardHeader
          icon={ShieldCheck}
          title={t("settings.ai.consent.title")}
        />
        <QueryErrorRow
          slot="ai-consent-load-error"
          onRetry={() => void refetch()}
        />
      </SettingsCard>
    );
  }

  // Narrow to the receipt itself rather than a boolean, so the branches
  // below can read its fields without an assertion.
  const activeReceipt = data && data.revokedAt === null ? data : null;

  return (
    <>
      <SettingsCard as="section" data-slot="ai-consent">
        <SettingsCardHeader
          icon={activeReceipt ? ShieldCheck : ShieldOff}
          title={t("settings.ai.consent.title")}
          description={
            activeReceipt
              ? t("settings.ai.consent.activeSince", {
                  date: formatDateTime(activeReceipt.signedAt),
                })
              : t("settings.ai.consent.withdrawn")
          }
        />

        {activeReceipt && confirming ? (
          <p className="text-muted-foreground text-xs">
            {t("settings.ai.consent.confirmBody")}
          </p>
        ) : null}
        {!activeReceipt ? (
          <p className="text-muted-foreground text-xs">
            {t("settings.ai.consent.regrantHint")}
          </p>
        ) : null}

        {revoke.isError ? (
          <p className="text-destructive text-xs" role="alert">
            {t("settings.ai.consent.error")}
          </p>
        ) : null}

        {grant.isError ? (
          <p className="text-destructive text-xs" role="alert">
            {t("settings.ai.consent.grantError")}
          </p>
        ) : null}

        {/* One action row, last in the card; while confirming, Cancel sits
            before the destructive confirm (design standards §12). */}
        <SettingsCardActions>
          {activeReceipt ? (
            confirming ? (
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
            )
          ) : (
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-9"
              data-slot="ai-consent-grant"
              onClick={() => grant.mutate()}
              disabled={grant.isPending}
            >
              {grant.isPending ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("settings.ai.consent.grant")}
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
          date: formatDateTime(active.signedAt),
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
