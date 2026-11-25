"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslations } from "@/lib/i18n/context";
import type { PushRelaySwitchBody } from "./use-push-relay";

/*
 * Turning the push relay on, shared by the switch (`push-relay-section.tsx`)
 * and the answer yes to the relay question (`push-relay-question.tsx`): the
 * relay terms, the privacy notice and the household confirmation, each on its
 * own, and the relay's invite code.
 */

/**
 * Registration refusals the admin can act on, by the `reason` the server
 * reports. Any other reason stays with the state badge.
 */
const REASON_LABEL = new Map<
  string,
  | "admin.pushRelay.reason.inviteRequired"
  | "admin.pushRelay.reason.inviteRejected"
  | "admin.pushRelay.reason.registrationPaused"
>([
  ["invite_required", "admin.pushRelay.reason.inviteRequired"],
  ["invite_rejected", "admin.pushRelay.reason.inviteRejected"],
  ["registration_paused", "admin.pushRelay.reason.registrationPaused"],
]);

/** The reasons an invite code moves on. */
export const INVITE_REASONS = new Set(["invite_required", "invite_rejected"]);

/** The relay's one-time invite code: 24 base64url characters. */
const INVITE_PATTERN = /^[A-Za-z0-9_-]{24}$/;

/**
 * The refusal of a registration the switch left unfinished, when the admin
 * can act on it; undefined otherwise.
 */
export function relayRefusalLabel(status: {
  offered: boolean;
  instanceId: string | null;
  reason: string | null;
}) {
  return status.offered && !status.instanceId && status.reason
    ? REASON_LABEL.get(status.reason)
    : undefined;
}

/**
 * One confirmation of the enable dialog: a checkbox, its sentence, and the
 * document the sentence is about.
 */
function ConfirmationRow({
  id,
  checked,
  onCheckedChange,
  label,
  link,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  link: { href: string; label: string } | null;
}) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <Checkbox
        id={id}
        data-slot={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="mt-0.5"
      />
      <div className="space-y-0.5">
        <Label htmlFor={id} noColon className="leading-snug font-normal">
          {label}
        </Label>
        {link && (
          <a
            className="block text-xs underline"
            href={link.href}
            target="_blank"
            rel="noreferrer"
          >
            {link.label}
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * Turning the relay on: the three confirmations, and the relay's invite code
 * for a relay that accepts new servers by invitation only. In `confirm` mode
 * the relay is on already and the admin confirms a changed text: the same
 * text and confirmations, no invite code.
 */
export function PushRelayEnableDialog({
  mode,
  termsUrl,
  privacyUrl,
  open,
  onOpenChange,
  onConfirm,
}: {
  mode: "enable" | "confirm";
  termsUrl: string | null;
  privacyUrl: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (body: PushRelaySwitchBody) => void;
}) {
  const { t } = useTranslations();
  // Two confirmations the admin gives separately: accepting the terms and
  // having read the privacy notice. Both travel as the one `acceptTerms`
  // field the relay registration has always taken.
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [readPrivacy, setReadPrivacy] = useState(false);
  const [householdOnly, setHouseholdOnly] = useState(false);
  const [invite, setInvite] = useState("");
  const inviteTrimmed = invite.trim();
  const inviteInvalid =
    inviteTrimmed !== "" && !INVITE_PATTERN.test(inviteTrimmed);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(
              mode === "confirm"
                ? "admin.pushRelay.reconfirm.title"
                : "admin.pushRelay.dialogTitle",
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("admin.pushRelay.dialogBody")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <ConfirmationRow
            id="push-relay-accept-terms"
            checked={acceptTerms}
            onCheckedChange={setAcceptTerms}
            label={t("admin.pushRelay.acceptTerms")}
            link={
              termsUrl
                ? { href: termsUrl, label: t("admin.pushRelay.terms") }
                : null
            }
          />
          <ConfirmationRow
            id="push-relay-read-privacy"
            checked={readPrivacy}
            onCheckedChange={setReadPrivacy}
            label={t("admin.pushRelay.readPrivacy")}
            link={
              privacyUrl
                ? { href: privacyUrl, label: t("admin.pushRelay.privacy") }
                : null
            }
          />
          <ConfirmationRow
            id="push-relay-household"
            checked={householdOnly}
            onCheckedChange={setHouseholdOnly}
            label={t("admin.pushRelay.householdOnly")}
            link={null}
          />
          {mode === "enable" && (
            <div className="space-y-1">
              <Label htmlFor="push-relay-invite">
                {t("admin.pushRelay.invite.label")}
              </Label>
              <Input
                id="push-relay-invite"
                data-slot="push-relay-invite"
                value={invite}
                onChange={(event) => setInvite(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                aria-invalid={inviteInvalid || undefined}
                aria-describedby="push-relay-invite-hint"
              />
              <p
                id="push-relay-invite-hint"
                className="text-muted-foreground text-xs"
              >
                {t(
                  inviteInvalid
                    ? "admin.pushRelay.invite.invalid"
                    : "admin.pushRelay.invite.hint",
                )}
              </p>
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("admin.pushRelay.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={
              !acceptTerms || !readPrivacy || !householdOnly || inviteInvalid
            }
            onClick={() =>
              onConfirm({
                enabled: true,
                acceptTerms: true,
                householdOnly: true,
                ...(inviteTrimmed ? { invite: inviteTrimmed } : {}),
              })
            }
          >
            {t(
              mode === "confirm"
                ? "admin.pushRelay.reconfirm.confirm"
                : "admin.pushRelay.enable",
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
