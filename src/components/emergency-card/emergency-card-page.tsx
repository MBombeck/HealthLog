"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartPulse, Loader2, QrCode } from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FieldGroup } from "@/components/ui/field-group";
import { InlineAction } from "@/components/ui/inline-action";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import {
  recentProofErrorMessage,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";
import { apiDelete, apiFetchRaw, apiGet, apiPost } from "@/lib/api/api-fetch";
import type { EmergencyCardView } from "@/lib/emergency-card/card-data";
import {
  DEFAULT_LINK_FIELDS,
  EMERGENCY_CARD_FIELDS,
  type EmergencyCardField,
} from "@/lib/emergency-card/fields";
import type { CardLinkSummary } from "@/lib/emergency-card/manage";
import { useDisplayTimezone, useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/relative-time";
import { queryKeys } from "@/lib/query-keys";

import { EmergencyCardSheet } from "./emergency-card-sheet";

/**
 * The owner's emergency card: the card as it reads, the ways to carry
 * it (an offline copy, a wallet card), and the QR link a first responder can
 * scan.
 *
 * The link shows only the items ticked here, is frozen when it is made, can
 * be given an end, is revoked with one confirm, and every opening lands on
 * the owner's audit trail; the card says how often and when last. Its URL
 * exists once, in the moment it is made, so the QR code and the wallet card
 * with the code are offered then.
 */

const LINK_PATH = "/api/emergency-card/link";
const EXPIRY_CHOICES = ["none", "30", "365", "730"] as const;
type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

interface Minted {
  url: string;
  link: CardLinkSummary;
}

/** Save a response body as a file. */
async function saveResponse(res: Response, filename: string): Promise<void> {
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function tokenOf(url: string): string | undefined {
  return url.split("/e/")[1];
}

export function EmergencyCardPage() {
  const { t, locale } = useTranslations();
  const card = useQuery({
    queryKey: queryKeys.emergencyCard(),
    queryFn: () => apiGet<{ card: EmergencyCardView }>("/api/emergency-card"),
  });
  const [busy, setBusy] = useState<"offline" | "wallet" | null>(null);
  const [downloadError, setDownloadError] = useState(false);
  const [minted, setMinted] = useState<Minted | null>(null);

  async function download(kind: "offline" | "wallet") {
    setBusy(kind);
    setDownloadError(false);
    try {
      const res =
        kind === "offline"
          ? await apiFetchRaw("/api/emergency-card/offline")
          : await apiFetchRaw("/api/emergency-card/wallet", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                minted ? { token: tokenOf(minted.url) } : {},
              ),
            });
      if (!res.ok) throw new Error(String(res.status));
      const today = card.data?.card.asOf ?? "card";
      await saveResponse(
        res,
        kind === "offline"
          ? `healthlog-emergency-card-${today}.html`
          : `healthlog-wallet-card-${today}.pdf`,
      );
    } catch {
      setDownloadError(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("emergencyCard.page.title")}
        description={t("emergencyCard.page.description")}
        // The way back is named after the page it opens: the card is filled
        // from Medical history.
        backLink={{
          href: "/settings/anamnesis",
          label: t("settings.sections.anamnesis.title"),
        }}
      />

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <Card data-slot="emergency-card-preview">
          <CardHeader>
            <TileHeader
              icon={HeartPulse}
              title={t("emergencyCard.page.preview")}
            />
          </CardHeader>
          <CardContent className="space-y-4">
            {card.isError ? (
              <QueryErrorCard
                error={card.error}
                title={t("emergencyCard.page.loadError")}
                onRetry={() => void card.refetch()}
              />
            ) : !card.data ? (
              <div className="flex h-24 items-center justify-center">
                <Loader2 className="text-muted-foreground size-5 animate-spin motion-reduce:animate-none" />
              </div>
            ) : (
              <EmergencyCardSheet view={card.data.card} t={t} locale={locale} />
            )}
            <p className="text-sm">
              {t("emergencyCard.page.editHint")}{" "}
              <InlineAction size="sm" asChild>
                <Link href="/settings/anamnesis#emergency">
                  {t("emergencyCard.page.editLink")}
                </Link>
              </InlineAction>
            </p>
            <p className="text-muted-foreground text-sm">
              {t("emergencyCard.page.offlineHint")}
            </p>
            {downloadError ? (
              <p className="text-destructive text-sm" role="alert">
                {t("emergencyCard.page.downloadError")}
              </p>
            ) : null}
            <SettingsCardActions>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void download("offline")}
              >
                {busy === "offline" ? (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                ) : null}
                {t("emergencyCard.page.saveOffline")}
              </Button>
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => void download("wallet")}
              >
                {busy === "wallet" ? (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                ) : null}
                {minted
                  ? t("emergencyCard.page.walletWithQr")
                  : t("emergencyCard.page.wallet")}
              </Button>
            </SettingsCardActions>
          </CardContent>
        </Card>

        <LinkCard minted={minted} onMinted={setMinted} />
      </div>
    </div>
  );
}

function LinkCard({
  minted,
  onMinted,
}: {
  minted: Minted | null;
  onMinted: (m: Minted | null) => void;
}) {
  const { t } = useTranslations();
  const qc = useQueryClient();
  const key = queryKeys.emergencyCardLink();
  const status = useQuery({
    queryKey: key,
    queryFn: () => apiGet<{ link: CardLinkSummary | null }>(LINK_PATH),
  });
  const proof = useRecentProof();
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  const mint = useMutation({
    mutationKey: key,
    mutationFn: (body: {
      fields: EmergencyCardField[];
      expiresInDays: number | null;
    }) => proof.run(() => apiPost<Minted>("/api/emergency-card/link", body)),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
  const revoke = useMutation({
    mutationKey: key,
    mutationFn: () => apiDelete(LINK_PATH),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });

  async function create(body: {
    fields: EmergencyCardField[];
    expiresInDays: number | null;
  }) {
    setError(null);
    try {
      const made = await mint.mutateAsync(body);
      onMinted(made);
      // The QR code is drawn on the device, from the one copy of the URL.
      const { default: QRCode } = await import("qrcode");
      setQr(await QRCode.toDataURL(made.url, { margin: 2, width: 512 }));
    } catch (err) {
      setError(recentProofErrorMessage(err, t("emergencyCard.link.error")));
    }
  }

  const link = status.data?.link ?? null;
  // A refusal stands above the action row it answers (§12), so the form and
  // the status each place it before their own row.
  const errorLine =
    error || revoke.isError ? (
      <p className="text-destructive text-sm" role="alert">
        {error ?? t("emergencyCard.link.error")}
      </p>
    ) : null;
  return (
    <Card data-slot="emergency-card-link-card">
      <CardHeader>
        <TileHeader icon={QrCode} title={t("emergencyCard.link.title")} />
      </CardHeader>
      <CardContent className="space-y-4">
        {status.isError ? (
          <QueryErrorCard
            error={status.error}
            title={t("emergencyCard.link.loadError")}
            onRetry={() => void status.refetch()}
          />
        ) : !status.data ? (
          <div className="flex h-16 items-center justify-center">
            <Loader2 className="text-muted-foreground size-5 animate-spin motion-reduce:animate-none" />
          </div>
        ) : !link ? (
          <LinkForm
            pending={mint.isPending}
            onCreate={(b) => void create(b)}
            error={errorLine}
          />
        ) : (
          <LinkStatus
            error={errorLine}
            link={link}
            minted={minted && qr ? { url: minted.url, qr } : null}
            revokePending={revoke.isPending}
            onRevoke={() =>
              revoke.mutate(undefined, {
                onSuccess: () => {
                  onMinted(null);
                  setQr(null);
                },
              })
            }
          />
        )}
        {proof.dialog}
      </CardContent>
    </Card>
  );
}

/** What the link will show and when it ends, before it exists. */
function LinkForm({
  pending,
  onCreate,
  error,
}: {
  pending: boolean;
  error: ReactNode;
  onCreate: (body: {
    fields: EmergencyCardField[];
    expiresInDays: number | null;
  }) => void;
}) {
  const { t } = useTranslations();
  const [fields, setFields] = useState<Set<EmergencyCardField>>(
    () => new Set(DEFAULT_LINK_FIELDS),
  );
  const [expiry, setExpiry] = useState<ExpiryChoice>("none");
  return (
    <>
      <p className="text-sm">{t("emergencyCard.link.disclosure")}</p>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          {t("emergencyCard.link.fieldsLabel")}
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {EMERGENCY_CARD_FIELDS.map((f) => (
            <div key={f} className="flex min-h-11 items-center gap-2">
              <Checkbox
                id={`card-field-${f}`}
                checked={fields.has(f)}
                onCheckedChange={(on) =>
                  setFields((prev) => {
                    const next = new Set(prev);
                    if (on === true) next.add(f);
                    else next.delete(f);
                    return next;
                  })
                }
              />
              <Label noColon htmlFor={`card-field-${f}`} className="text-sm">
                {t(`emergencyCard.fields.${f}`)}
              </Label>
            </div>
          ))}
        </div>
      </fieldset>
      <FieldGroup
        htmlFor="card-link-expiry"
        label={t("emergencyCard.link.expiryLabel")}
      >
        <NativeSelect
          id="card-link-expiry"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value as ExpiryChoice)}
        >
          {EXPIRY_CHOICES.map((c) => (
            <option key={c} value={c}>
              {t(`emergencyCard.link.expiry.${c}`)}
            </option>
          ))}
        </NativeSelect>
      </FieldGroup>
      {error}
      <SettingsCardActions>
        <Button
          size="sm"
          disabled={pending || fields.size === 0}
          onClick={() =>
            onCreate({
              fields: EMERGENCY_CARD_FIELDS.filter((f) => fields.has(f)),
              expiresInDays: expiry === "none" ? null : Number(expiry),
            })
          }
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          ) : null}
          {t("emergencyCard.link.create")}
        </Button>
      </SettingsCardActions>
    </>
  );
}

/** The live link: its code (only right after it was made), scope, use. */
function LinkStatus({
  link,
  minted,
  revokePending,
  onRevoke,
  error,
}: {
  error: ReactNode;
  link: CardLinkSummary;
  minted: { url: string; qr: string } | null;
  revokePending: boolean;
  onRevoke: () => void;
}) {
  const { t, locale } = useTranslations();
  const timeZone = useDisplayTimezone();
  return (
    <>
      {minted ? (
        <div className="space-y-2" data-slot="emergency-card-qr">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data URL drawn on the device */}
          <img
            src={minted.qr}
            alt={t("emergencyCard.link.qrAlt")}
            className="mx-auto size-48 rounded-lg bg-white p-2"
          />
          <code className="bg-muted block rounded-md px-3 py-2 text-sm break-all">
            {minted.url}
          </code>
          <p className="text-sm">{t("emergencyCard.link.once")}</p>
        </div>
      ) : (
        <p className="text-sm">
          {t("emergencyCard.link.hidden", { prefix: link.tokenPrefix })}
        </p>
      )}
      <p className="text-sm">
        {t("emergencyCard.link.shows", {
          items: link.fields
            .map((f) => t(`emergencyCard.fields.${f}`))
            .join(", "),
        })}
      </p>
      <p className="text-muted-foreground text-sm">
        {link.expired
          ? t("emergencyCard.link.expired")
          : link.expiresAt
            ? t("emergencyCard.link.expiresOn", {
                date: new Intl.DateTimeFormat(locale, {
                  dateStyle: "long",
                  timeZone,
                }).format(new Date(link.expiresAt)),
              })
            : t("emergencyCard.link.noExpiry")}
      </p>
      <p className="text-muted-foreground text-sm">
        {link.lastAccessAt
          ? t("emergencyCard.link.opened", {
              count: link.accessCount,
              when: formatRelativeTime(link.lastAccessAt, t, locale),
            })
          : t("emergencyCard.link.notOpened")}
      </p>
      {error}
      <SettingsCardActions>
        <ConfirmButton
          label={t("emergencyCard.link.revoke")}
          title={t("emergencyCard.link.revokeTitle")}
          body={t("emergencyCard.link.revokeBody")}
          confirmLabel={t("emergencyCard.link.revoke")}
          onConfirm={onRevoke}
          pending={revokePending}
          variant="destructive"
          destructive
          size="sm"
        />
      </SettingsCardActions>
    </>
  );
}
