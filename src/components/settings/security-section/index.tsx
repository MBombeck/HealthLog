"use client";

import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { PasswordCard } from "@/components/settings/password-card";
import { SecurityActivityCard } from "@/components/settings/security-activity-card";
import { SecuritySessionsCard } from "@/components/settings/security-sessions-card";
import { TrustedDevicesCard } from "@/components/settings/trusted-devices-card";
import { TotpCard } from "./totp-card";
import { SecurityKeysCard, type WebauthnKeyInfo } from "./security-keys-card";
import { PasskeyListSection } from "./passkey-list-section";
import { PasskeyUpgradeNudge } from "./passkey-upgrade-nudge";

interface MfaStatus {
  totp: { enabled: boolean };
  recoveryCodesRemaining: number;
  webauthn: WebauthnKeyInfo[];
  passkeyNudgeDismissed: boolean;
  proofMethods: string[];
}

interface PasskeyInfo {
  id: string;
}

export function SecuritySection() {
  const { isAuthenticated } = useAuth();

  const { data: status, isLoading } = useQuery({
    queryKey: queryKeys.mfaStatus(),
    queryFn: async () => apiGet<MfaStatus>("/api/auth/me/mfa"),
    enabled: isAuthenticated,
  });

  // Passkey count drives whether the upgrade nudge shows. Shares the cached
  // `passkeys()` key with the list below, so this is not an extra round-trip.
  const { data: passkeys } = useQuery({
    queryKey: queryKeys.passkeys(),
    queryFn: async () => apiGet<PasskeyInfo[]>("/api/auth/passkeys"),
    enabled: isAuthenticated,
  });

  const showNudge =
    status != null &&
    !status.passkeyNudgeDismissed &&
    passkeys != null &&
    passkeys.length === 0;

  return (
    <div className="space-y-6">
      {showNudge && <PasskeyUpgradeNudge />}

      {isLoading || !status ? (
        <>
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </>
      ) : (
        <>
          <TotpCard
            enabled={status.totp.enabled}
            recoveryCodesRemaining={status.recoveryCodesRemaining}
          />

          <SecurityKeysCard
            keys={status.webauthn}
            totpEnabled={status.totp.enabled}
          />

          <PasskeyListSection
            isAuthenticated={isAuthenticated}
            proofMethods={status.proofMethods}
          />
        </>
      )}

      {/* The password comes last: authenticator, then security keys, then
          passkeys, then the password. It sits OUTSIDE the status conditional
          on purpose — it depends on nothing this page fetches and is the only
          way to change a password now that the Account card is gone, so a
          `/api/auth/me/mfa` that never answers must not take it down with the
          cards that do need the status. */}
      <PasswordCard />

      {/* v1.44 — who is signed in and what happened, beside the controls
          that decide how one signs in. These lived on the privacy page;
          `/settings/privacy#sessions` (and the other two anchors) forward
          here. Outside the status conditional for the same reason as the
          password: they read their own routes. */}
      <SecuritySessionsCard isAuthenticated={isAuthenticated} />
      <TrustedDevicesCard isAuthenticated={isAuthenticated} />
      <SecurityActivityCard isAuthenticated={isAuthenticated} />
    </div>
  );
}
