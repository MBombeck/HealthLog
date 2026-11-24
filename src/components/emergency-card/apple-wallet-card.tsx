"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Wallet } from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import {
  recentProofErrorMessage,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmButton, ConfirmDialog } from "@/components/ui/confirm-button";
import { Disclosure } from "@/components/ui/disclosure";
import { FieldGroup } from "@/components/ui/field-group";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useAuth } from "@/hooks/use-auth";
import { apiDelete, apiPost } from "@/lib/api/api-fetch";
import {
  DEFAULT_WALLET_FIELDS,
  EMERGENCY_CARD_FIELDS,
  type EmergencyCardField,
} from "@/lib/emergency-card/fields";
import type { EmergencyWalletApple } from "@/lib/emergency-card/wallet-pass/availability";
import { useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/relative-time";
import { queryKeys } from "@/lib/query-keys";

/**
 * The emergency card in Apple Wallet (v1.50): add it, see whether it is
 * live, withdraw it.
 *
 * Everything the card shows is the server's answer on `/api/auth/me`
 * (`emergencyCard.wallet.apple`): whether a pass can be made here, who signs
 * it, and the pass the record has. Nothing is recomputed here.
 *
 * The text stays short on purpose: one sentence, the rest behind "Learn
 * more". Apple's own "Add to Wallet" artwork is licensed to members of the
 * Apple Developer Program and may not be redrawn, so the action is a plain
 * button with the words; on a device that cannot add passes, one line says
 * where to open the page (Apple's guidelines ask for exactly that line).
 * The download is a top-level navigation, so Safari shows Apple's own add
 * sheet, in the browser and in the installed app alike.
 */

const EXPIRY_CHOICES = ["none", "30", "365", "730"] as const;
type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];
type Pass = NonNullable<EmergencyWalletApple["pass"]>;

const noSubscription = () => () => {};

/**
 * Whether this browser can add a pass to Wallet (iPhone, iPad, Mac); null
 * while rendering on the server.
 */
function useCanAddPasses(): boolean | null {
  return useSyncExternalStore(
    noSubscription,
    // iPadOS names itself a Mac; both add passes from Safari.
    () => /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent),
    () => null,
  );
}

function openPass(downloadPath: string) {
  window.location.assign(downloadPath);
}

export function AppleWalletCard() {
  const { t } = useTranslations();
  const { user, profileLoaded } = useAuth();
  // The page's seed carries no Wallet state: wait for the full account.
  const apple = profileLoaded
    ? (user?.emergencyCard?.wallet.apple ?? null)
    : null;
  // A delegate on an adult's record has nothing to do here, and a server
  // that publishes no Wallet state (or none for this record) shows no card.
  if (!apple || apple.reason === "not_allowed") return null;
  return (
    <Card id="wallet" data-slot="emergency-card-wallet-card">
      <CardHeader>
        <TileHeader
          icon={Wallet}
          title={t("emergencyCard.appleWallet.title")}
          right={apple.pass ? <PassStateBadge pass={apple.pass} /> : null}
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <WalletBody apple={apple} />
      </CardContent>
    </Card>
  );
}

function PassStateBadge({ pass }: { pass: Pass }) {
  const { t } = useTranslations();
  return (
    <Badge
      variant={pass.state === "live" ? "secondary" : "outline"}
      data-slot="wallet-pass-state"
      data-state={pass.state}
    >
      {t(`emergencyCard.appleWallet.state.${pass.state}`)}
    </Badge>
  );
}

function WalletBody({ apple }: { apple: EmergencyWalletApple }) {
  const { t } = useTranslations();
  const qc = useQueryClient();
  const proof = useRecentProof();
  const canAdd = useCanAddPasses();
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.authMe() });
  const create = useMutation({
    mutationKey: queryKeys.emergencyCardWallet(),
    mutationFn: (body: {
      fields: EmergencyCardField[];
      expiresInDays: number | null;
    }) =>
      proof.run(() =>
        apiPost<{ downloadPath: string }>("/api/emergency-card/wallet/apple", {
          ...body,
          consentTextVersion: apple.consentTextVersion ?? "local",
        }),
      ),
    onSettled: refresh,
  });
  const withdraw = useMutation({
    mutationKey: queryKeys.emergencyCardWallet(),
    mutationFn: () => apiDelete("/api/emergency-card/wallet/apple"),
    onSettled: refresh,
  });

  async function make(body: {
    fields: EmergencyCardField[];
    expiresInDays: number | null;
  }) {
    setError(null);
    try {
      const made = await create.mutateAsync(body);
      setFresh(false);
      openPass(made.downloadPath);
    } catch (err) {
      setError(
        recentProofErrorMessage(err, t("emergencyCard.appleWallet.error")),
      );
    }
  }

  const pass = apple.pass;
  const errorLine =
    error || withdraw.isError ? (
      <p className="text-destructive text-sm" role="alert">
        {error ?? t("emergencyCard.appleWallet.error")}
      </p>
    ) : null;
  const otherDevice =
    canAdd === false ? (
      <p className="text-muted-foreground text-sm">
        {t("emergencyCard.appleWallet.otherDevice")}
      </p>
    ) : null;

  // Live: add it to this device, or withdraw it.
  if (pass && pass.state === "live") {
    return (
      <>
        <PassFacts pass={pass} />
        <LearnMore apple={apple} />
        {otherDevice}
        {errorLine}
        {proof.dialog}
        <SettingsCardActions>
          <ConfirmButton
            label={t("emergencyCard.appleWallet.withdraw")}
            title={t("emergencyCard.appleWallet.withdrawTitle")}
            body={t("emergencyCard.appleWallet.withdrawBody")}
            confirmLabel={t("emergencyCard.appleWallet.withdraw")}
            onConfirm={() => withdraw.mutate()}
            pending={withdraw.isPending}
            variant="destructive"
            destructive
            size="sm"
            slot="wallet-withdraw"
          />
          <Button
            size="sm"
            data-slot="wallet-add"
            onClick={() => openPass(pass.downloadPath)}
          >
            {t("emergencyCard.appleWallet.add")}
          </Button>
        </SettingsCardActions>
      </>
    );
  }

  // Not available on this server, and no pass to look after.
  if (!apple.available && !pass) {
    return (
      <p className="text-sm" data-slot="wallet-unavailable">
        {t(`emergencyCard.appleWallet.unavailable.${apple.reason}`)}
      </p>
    );
  }

  // Withdrawn or expired: say so; a new one once asked for.
  if (pass && !fresh) {
    return (
      <>
        <PassFacts pass={pass} />
        {errorLine}
        {apple.available ? (
          <SettingsCardActions>
            <Button size="sm" onClick={() => setFresh(true)}>
              {t("emergencyCard.appleWallet.makeNew")}
            </Button>
          </SettingsCardActions>
        ) : null}
      </>
    );
  }

  return (
    <>
      <p className="text-sm">{t("emergencyCard.appleWallet.lead")}</p>
      <LearnMore apple={apple} />
      {proof.dialog}
      <PassForm
        apple={apple}
        pending={create.isPending}
        error={errorLine}
        note={otherDevice}
        onCreate={(body) => void make(body)}
      />
    </>
  );
}

/** What the pass shows, and its one line of state. */
function PassFacts({ pass }: { pass: Pass }) {
  const { t, locale } = useTranslations();
  const items = pass.fields
    .map((f) => t(`emergencyCard.fields.${f}`))
    .join(", ");
  const when = (iso: string) => formatRelativeTime(iso, t, locale);
  const state =
    pass.state === "voided"
      ? t(`emergencyCard.appleWallet.withdrawn.${pass.voidReason ?? "owner"}`, {
          when: pass.voidedAt ? when(pass.voidedAt) : "",
        })
      : pass.state === "expired"
        ? t("emergencyCard.appleWallet.expired")
        : pass.lastFetchedAt
          ? t("emergencyCard.appleWallet.fetched", {
              when: when(pass.lastFetchedAt),
            })
          : t("emergencyCard.appleWallet.notFetched");
  return (
    <>
      {/* A withdrawn pass shows nothing any more. */}
      {pass.state === "voided" ? null : (
        <p className="text-sm">{t("emergencyCard.link.shows", { items })}</p>
      )}
      <p className="text-muted-foreground text-sm" data-slot="wallet-pass-line">
        {state}
      </p>
    </>
  );
}

/** The details, one short line each, behind one "Learn more". */
function LearnMore({ apple }: { apple: EmergencyWalletApple }) {
  const { t } = useTranslations();
  return (
    <Disclosure summary={t("emergencyCard.appleWallet.learnMore")}>
      <p>{t("emergencyCard.appleWallet.more.frozen")}</p>
      <p>{t("emergencyCard.appleWallet.more.updates")}</p>
      <p>{t("emergencyCard.appleWallet.more.lock")}</p>
      <p>
        {apple.signer === "local"
          ? t("emergencyCard.appleWallet.more.signerLocal")
          : t("emergencyCard.appleWallet.more.signerRelay")}
      </p>
      <p>{t("emergencyCard.appleWallet.more.withdraw")}</p>
    </Disclosure>
  );
}

function PassForm({
  apple,
  pending,
  error,
  note,
  onCreate,
}: {
  apple: EmergencyWalletApple;
  pending: boolean;
  error: ReactNode;
  note: ReactNode;
  onCreate: (body: {
    fields: EmergencyCardField[];
    expiresInDays: number | null;
  }) => void;
}) {
  const { t } = useTranslations();
  const [fields, setFields] = useState<Set<EmergencyCardField>>(
    () => new Set(DEFAULT_WALLET_FIELDS),
  );
  const [expiry, setExpiry] = useState<ExpiryChoice>("none");
  const [consent, setConsent] = useState(false);
  const body = () => ({
    fields: EMERGENCY_CARD_FIELDS.filter((f) => fields.has(f)),
    expiresInDays: expiry === "none" ? null : Number(expiry),
  });
  // The project signs: the person reads, once per pass, what its signing
  // service sees. A server that signs with its own certificate asks nothing.
  const asks = apple.signer === "relay";
  return (
    <>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          {t("emergencyCard.appleWallet.fieldsLabel")}
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {EMERGENCY_CARD_FIELDS.map((f) => (
            <div key={f} className="flex min-h-11 items-center gap-2">
              <Checkbox
                id={`wallet-field-${f}`}
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
              <Label noColon htmlFor={`wallet-field-${f}`} className="text-sm">
                {t(`emergencyCard.fields.${f}`)}
              </Label>
            </div>
          ))}
        </div>
      </fieldset>
      <FieldGroup
        htmlFor="wallet-expiry"
        label={t("emergencyCard.appleWallet.expiryLabel")}
      >
        <NativeSelect
          id="wallet-expiry"
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
      {note}
      {error}
      <ConfirmDialog
        open={consent}
        onOpenChange={setConsent}
        title={t("emergencyCard.appleWallet.consentTitle")}
        body={t("emergencyCard.appleWallet.consentBody")}
        confirmLabel={t("emergencyCard.appleWallet.add")}
        slot="wallet-consent"
        onConfirm={() => {
          setConsent(false);
          onCreate(body());
        }}
      />
      <SettingsCardActions>
        <Button
          size="sm"
          data-slot="wallet-create"
          disabled={pending || fields.size === 0 || !apple.canCreate}
          onClick={() => (asks ? setConsent(true) : onCreate(body()))}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          ) : null}
          {t("emergencyCard.appleWallet.add")}
        </Button>
      </SettingsCardActions>
    </>
  );
}
