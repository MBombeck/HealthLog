"use client";

import {
  lazy,
  Suspense,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
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
import { ConfirmButton, ConfirmDialog } from "@/components/ui/confirm-button";
import { Disclosure } from "@/components/ui/disclosure";
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

import { CardFieldRows, type ExpiryChoice } from "./card-field-rows";

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
 *
 * A server that signs over the push relay while the relay is off
 * (`state: relay_off`) keeps the action: a tap explains, and an admin
 * switches the relay on right there (`wallet-relay-gate.tsx`, loaded only
 * then). Once it is on, the card goes on to the pass by itself.
 */

const WalletRelayGate = lazy(() =>
  import("./wallet-relay-gate").then((m) => ({ default: m.WalletRelayGate })),
);

/** How long the card waits for a relay just switched on to sign. */
const RELAY_WAIT_MS = 3 * 60_000;
const RELAY_POLL_MS = 5_000;

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
  const [gateOpen, setGateOpen] = useState(false);
  // The relay was just switched on here: read the server again until it
  // signs, then go on to the pass.
  const [waiting, setWaiting] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.authMe() });
  const gated = apple.state === "relay_off";

  useEffect(() => {
    if (!waiting || apple.available) return;
    const started = Date.now();
    const id = window.setInterval(() => {
      if (Date.now() - started > RELAY_WAIT_MS) {
        window.clearInterval(id);
        setWaiting(false);
        return;
      }
      void qc.invalidateQueries({ queryKey: queryKeys.authMe() });
    }, RELAY_POLL_MS);
    return () => window.clearInterval(id);
  }, [waiting, apple.available, qc]);
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
    setWaiting(false);
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

  // Live: add it to one more device, or withdraw it. Withdrawing is the
  // secondary action (outline, behind a confirmation), never a second red
  // button beside the one a person came for.
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
            variant="outline"
            destructive
            size="sm"
            slot="wallet-withdraw"
          />
          <Button
            size="sm"
            data-slot="wallet-add"
            onClick={() => openPass(pass.downloadPath)}
          >
            {/* Once a device has fetched it, the next one is another device. */}
            {pass.lastFetchedAt
              ? t("emergencyCard.appleWallet.addAnother")
              : t("emergencyCard.appleWallet.add")}
          </Button>
        </SettingsCardActions>
      </>
    );
  }

  const gate = gated ? (
    <Suspense fallback={null}>
      <WalletRelayGate
        apple={apple}
        open={gateOpen}
        onOpenChange={setGateOpen}
        onEnabled={() => setWaiting(true)}
      />
    </Suspense>
  ) : null;

  // Not available on this server, and no pass to look after.
  if (!apple.available && !gated && !waiting && !pass) {
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
        {apple.available || gated ? (
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
      {gated && !apple.relayHintDismissed ? (
        <p
          className="text-muted-foreground text-sm"
          data-slot="wallet-relay-hint"
        >
          {t("emergencyCard.appleWallet.relay.hint")}
        </p>
      ) : null}
      <LearnMore apple={apple} />
      {proof.dialog}
      {gate}
      <PassForm
        apple={apple}
        pending={create.isPending || (waiting && !apple.available)}
        error={errorLine}
        note={
          waiting && !apple.available ? (
            <p className="text-sm" data-slot="wallet-relay-starting">
              {t("emergencyCard.appleWallet.relay.starting")}
            </p>
          ) : (
            otherDevice
          )
        }
        gated={gated}
        onGate={() => setGateOpen(true)}
        resume={waiting && apple.available}
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
  gated,
  onGate,
  resume,
  onCreate,
}: {
  apple: EmergencyWalletApple;
  pending: boolean;
  error: ReactNode;
  note: ReactNode;
  /** The relay that would sign is off: the action explains instead. */
  gated: boolean;
  onGate: () => void;
  /** The relay just came on: go on as if the action had been tapped. */
  resume: boolean;
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
  const add = () => (asks ? setConsent(true) : onCreate(body()));
  // Adjusted while rendering, not in an effect: the tap the admin made
  // before switching the relay on carries on once the server signs.
  const [resumed, setResumed] = useState(false);
  if (resume && !resumed) {
    setResumed(true);
    if (asks) setConsent(true);
  }
  return (
    <>
      <CardFieldRows
        idPrefix="wallet"
        fieldsLabel={t("emergencyCard.appleWallet.fieldsLabel")}
        expiryLabel={t("emergencyCard.appleWallet.expiryLabel")}
        fields={fields}
        onFieldsChange={setFields}
        expiry={expiry}
        onExpiryChange={setExpiry}
      />
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
          disabled={
            pending || fields.size === 0 || (!apple.canCreate && !gated)
          }
          onClick={gated ? onGate : add}
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
