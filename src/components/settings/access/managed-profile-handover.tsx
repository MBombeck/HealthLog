"use client";

import { useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { stepUpErrorKey } from "@/components/settings/access/grant-action-error";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useAuth } from "@/hooks/use-auth";
import { ApiError } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  DEFAULT_HANDOVER_ACCESS,
  PROPOSABLE_HANDOVER_ACCESS,
  isHandoverMinor,
  type HandoverAccess,
} from "@/lib/managed-profiles/handover-access";
import {
  useCreateManagedProfileHandover,
  useManagedProfile,
  useManagedProfileHandover,
  useRevokeManagedProfileHandover,
  type ManagedProfileGuardian,
} from "@/lib/queries/use-managed-profiles";
import { accountLabel } from "@/lib/sharing/account-access-view";

/**
 * v1.42 (#959) — handing a managed profile over to the person it describes,
 * from the Guardian's side.
 *
 * Three states, one panel:
 *
 *   1. **Propose.** How long the link lives and, per active Guardian, what
 *      their access becomes. The irreversibility is said here, before the
 *      link exists, because it is the last moment the Guardian decides
 *      anything: once the person claims the profile, it is theirs.
 *   2. **The link, once.** Shown in the response that minted it and never
 *      again (only its hash is stored): the URL, a copy button and a QR code
 *      to scan from the Guardian's screen. Nothing is mailed; the Guardian
 *      hands it over in person or through a channel they trust.
 *   3. **Open.** Afterwards the panel shows that a link is open and until
 *      when, with the way to withdraw it. Making a new link withdraws the old.
 *
 * The rules of which levels exist and which one is the default live in
 * `handover-access.ts`; this panel only renders them.
 */
export function ManagedProfileHandover({
  profileId,
  profileName,
  roster,
  onClose,
}: {
  profileId: string;
  profileName: string;
  /** The resolved roster; the row withholds this panel until it arrives. */
  roster: ManagedProfileGuardian[];
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const status = useManagedProfileHandover(profileId);
  const create = useCreateManagedProfileHandover();
  const revoke = useRevokeManagedProfileHandover();
  const [replacing, setReplacing] = useState(false);

  const minted =
    create.data && create.variables?.profileId === profileId
      ? create.data
      : null;

  if (status.isError) {
    return (
      <QueryErrorCard
        title={t("recordSharing.managed.handover.loadError")}
        onRetry={() => void status.refetch()}
      />
    );
  }
  if (!status.data) {
    return (
      <p
        role="status"
        className="text-muted-foreground flex items-center gap-2 text-sm"
      >
        <Loader2
          className="size-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        {t("nav.loadingScreen")}
      </p>
    );
  }

  return (
    <section
      data-slot="managed-profile-handover"
      aria-label={t("recordSharing.managed.handover.title", {
        name: profileName,
      })}
      className="space-y-4 rounded-lg border p-3"
    >
      <p className="text-sm">
        {t("recordSharing.managed.handover.description", {
          name: profileName,
        })}
      </p>

      {!status.data.available ? (
        <>
          <p
            data-slot="managed-profile-handover-unavailable"
            className="text-sm"
          >
            {t("recordSharing.managed.handover.oidcOnly")}
          </p>
          <SettingsCardActions>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              onClick={onClose}
            >
              {t("common.close")}
            </Button>
          </SettingsCardActions>
        </>
      ) : minted ? (
        <HandoverLink
          link={minted}
          profileName={profileName}
          expiresLabel={fmt.dateTime(new Date(minted.expiresAt))}
          onDone={() => {
            create.reset();
            setReplacing(false);
            onClose();
          }}
        />
      ) : status.data.open && !replacing ? (
        <div data-slot="managed-profile-handover-open" className="space-y-3">
          <p className="text-sm">
            {t("recordSharing.managed.handover.pending", {
              date: fmt.dateTime(new Date(status.data.open.expiresAt)),
            })}
          </p>
          {revoke.isError && revoke.variables === profileId && (
            <p role="alert" className="text-destructive text-sm">
              {t("recordSharing.managed.handover.revokeFailed")}
            </p>
          )}
          <SettingsCardActions>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              data-slot="managed-profile-handover-revoke"
              disabled={revoke.isPending}
              onClick={() =>
                revoke.mutate(profileId, {
                  onSuccess: () =>
                    toastWrittenOutcome(
                      "success",
                      t("recordSharing.managed.handover.revoked"),
                    ),
                })
              }
            >
              {t("recordSharing.managed.handover.revoke")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-9"
              data-slot="managed-profile-handover-replace"
              onClick={() => setReplacing(true)}
            >
              {t("recordSharing.managed.handover.replace")}
            </Button>
          </SettingsCardActions>
        </div>
      ) : (
        <HandoverProposalForm
          profileId={profileId}
          profileName={profileName}
          roster={roster}
          replacing={status.data.open !== null}
          create={create}
          onCancel={() => {
            setReplacing(false);
            if (!status.data?.open) onClose();
          }}
        />
      )}
    </section>
  );
}

function HandoverProposalForm({
  profileId,
  profileName,
  roster,
  replacing,
  create,
  onCancel,
}: {
  profileId: string;
  profileName: string;
  roster: ManagedProfileGuardian[];
  replacing: boolean;
  create: ReturnType<typeof useCreateManagedProfileHandover>;
  onCancel: () => void;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const profile = useManagedProfile(profileId);
  const [expiresInDays, setExpiresInDays] = useState<1 | 7 | 14>(7);
  const [proposals, setProposals] = useState<Record<string, HandoverAccess>>(
    {},
  );

  const active = roster.filter((g) => g.state === "ACTIVE");
  const minor = isHandoverMinor(profile.data?.dateOfBirth ?? null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    create.mutate({
      profileId,
      expiresInDays,
      proposals: active.map((g) => ({
        grantId: g.grantId,
        proposal: proposals[g.grantId] ?? DEFAULT_HANDOVER_ACCESS,
      })),
    });
  };

  return (
    <form
      onSubmit={submit}
      data-slot="managed-profile-handover-form"
      className="space-y-4"
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          {t("recordSharing.managed.handover.guardiansLabel")}
        </legend>
        <p className="text-muted-foreground text-xs">
          {t("recordSharing.managed.handover.guardiansHint", {
            name: profileName,
          })}
        </p>
        <ul className="divide-y">
          {active.map((guardian) => {
            const id = `handover-proposal-${profileId}-${guardian.grantId}`;
            const isSelf = guardian.account.id === user?.id;
            return (
              <li
                key={guardian.grantId}
                data-slot="managed-profile-handover-guardian"
                data-guardian-grant-id={guardian.grantId}
                className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <Label
                  noColon
                  htmlFor={id}
                  className="block min-w-0 flex-1 truncate pl-0 text-sm font-normal"
                >
                  {accountLabel(guardian.account)}
                  {isSelf ? ` ${t("recordSharing.managed.guardianYou")}` : ""}
                </Label>
                <NativeSelect
                  id={id}
                  data-slot="managed-profile-handover-proposal"
                  className="w-40 shrink-0"
                  value={proposals[guardian.grantId] ?? DEFAULT_HANDOVER_ACCESS}
                  onChange={(e) =>
                    setProposals((current) => ({
                      ...current,
                      [guardian.grantId]: e.target.value as HandoverAccess,
                    }))
                  }
                >
                  {PROPOSABLE_HANDOVER_ACCESS.map((level) => (
                    <option key={level} value={level}>
                      {accessLabel(t, level)}
                    </option>
                  ))}
                </NativeSelect>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor={`handover-expiry-${profileId}`}>
          {t("recordSharing.managed.handover.expiryLabel")}
        </Label>
        <NativeSelect
          id={`handover-expiry-${profileId}`}
          data-slot="managed-profile-handover-expiry"
          className="w-full sm:w-48"
          value={String(expiresInDays)}
          onChange={(e) =>
            setExpiresInDays(Number(e.target.value) as 1 | 7 | 14)
          }
        >
          <option value="1">
            {t("recordSharing.managed.handover.expiry1")}
          </option>
          <option value="7">
            {t("recordSharing.managed.handover.expiry7")}
          </option>
          <option value="14">
            {t("recordSharing.managed.handover.expiry14")}
          </option>
        </NativeSelect>
      </div>

      {minor && (
        <p
          data-slot="managed-profile-handover-minor"
          className="bg-info/10 text-info rounded-md p-3 text-sm"
        >
          {t("recordSharing.managed.handover.minorHint", { name: profileName })}
        </p>
      )}

      <div className="space-y-2 text-sm">
        <p data-slot="managed-profile-handover-irreversible">
          {t("recordSharing.managed.handover.irreversible", {
            name: profileName,
          })}
        </p>
        <p>
          {t("recordSharing.managed.handover.afterwards", {
            name: profileName,
          })}
        </p>
        {replacing && <p>{t("recordSharing.managed.handover.replaceNote")}</p>}
      </div>

      {create.isError && (
        <p
          role="alert"
          data-slot="managed-profile-handover-error"
          className="text-destructive text-sm"
        >
          {t(handoverCreateErrorKey(create.error))}
        </p>
      )}

      <SettingsCardActions>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={onCancel}
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          size="sm"
          className="min-h-11 sm:min-h-9"
          data-slot="managed-profile-handover-create"
          disabled={create.isPending}
        >
          {create.isPending
            ? t("recordSharing.managed.handover.creating")
            : t("recordSharing.managed.handover.create")}
        </Button>
      </SettingsCardActions>
    </form>
  );
}

function HandoverLink({
  link,
  profileName,
  expiresLabel,
  onDone,
}: {
  link: { url: string; qrDataUrl: string };
  profileName: string;
  expiresLabel: string;
  onDone: () => void;
}) {
  const { t } = useTranslations();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      toastWrittenOutcome(
        "success",
        t("recordSharing.managed.handover.copied"),
      );
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      toast.error(t("recordSharing.managed.handover.copyError"));
    }
  }

  return (
    <div
      data-slot="managed-profile-handover-link"
      data-handover-url={link.url}
      className="space-y-4"
    >
      <p className="text-sm">
        {t("recordSharing.managed.handover.linkOnce", { name: profileName })}
      </p>
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        {/* The QR quiet zone stays white in both themes: a scanner needs the
            contrast, and UI-STANDARDS §4 names this exemption. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL minted client-side; nothing for the image optimiser to do */}
        <img
          src={link.qrDataUrl}
          alt={t("recordSharing.managed.handover.qrAlt", { name: profileName })}
          width={160}
          height={160}
          className="size-40 shrink-0 rounded-md bg-white p-1"
          data-slot="managed-profile-handover-qr"
        />
        <div className="w-full min-w-0 flex-1 space-y-2">
          <Label htmlFor="managed-profile-handover-url">
            {t("recordSharing.managed.handover.urlLabel")}
          </Label>
          <div className="flex gap-2">
            <Input
              id="managed-profile-handover-url"
              readOnly
              value={link.url}
              className="min-w-0 flex-1 font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 shrink-0 sm:min-h-9"
              data-slot="managed-profile-handover-copy"
              onClick={() => void copy()}
            >
              {copied ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              {t("recordSharing.managed.handover.copy")}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {t("recordSharing.managed.handover.linkExpires", {
              date: expiresLabel,
            })}
          </p>
        </div>
      </div>
      <SettingsCardActions>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          data-slot="managed-profile-handover-done"
          onClick={onDone}
        >
          {t("recordSharing.managed.handover.done")}
        </Button>
      </SettingsCardActions>
    </div>
  );
}

/** The label of a handover level, as literal keys the i18n guards can see. */
export function accessLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  access: HandoverAccess,
): string {
  switch (access) {
    case "end":
      return t("recordSharing.managed.handover.access.end");
    case "read":
      return t("recordSharing.managed.handover.access.read");
    case "manage":
      return t("recordSharing.managed.handover.access.manage");
  }
}

/** The message for a refused mint. Exported and pure so it can be pinned. */
export function handoverCreateErrorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return "recordSharing.managed.errorOffline";
  if (err.status === 401) return stepUpErrorKey(err);
  if (err.status === 403) return "recordSharing.managed.handover.oidcOnly";
  if (err.status === 404) return "recordSharing.actionError.profileNotFound";
  if (err.status === 422) {
    return err.meta?.errorCode === "managed_profile.handover.unknown_guardian"
      ? "recordSharing.managed.handover.errorRosterChanged"
      : "recordSharing.managed.errorInvalid";
  }
  if (err.status === 429) return "recordSharing.managed.errorRateLimit";
  return "recordSharing.managed.handover.errorFailed";
}
