"use client";

/**
 * `<RecoveryKitCard>` — the recovery kit on the admin Encryption page.
 *
 * Lists every key a restore of this server needs: the application keys
 * (including a retired one a backup still lists), the off-host backup keys and
 * the token key. Each row shows the key's id and fingerprint (never the key),
 * why the kit lists it and whether the confirmation covers it. Below them:
 * where the keys are set on each platform, the short restore path with a link
 * to the full guide, a "Check my copy" field and the confirmation.
 *
 * The confirmation sends the kit exactly as this card showed it. When the
 * server's kit changed since the page loaded (a rotation, a new backup key),
 * the server answers 409 and the card reloads.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineAction } from "@/components/ui/inline-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, apiFetch, apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import {
  useRecoveryKit,
  type KitKey,
  type KitPlatform,
  type RecoveryKit,
} from "./use-recovery-kit";

const PLATFORMS: KitPlatform[] = [
  "compose",
  "truenas",
  "coolify",
  "unraid",
  "portainer",
];

/** The disaster recovery guide in the repository, the same on every host. */
export const DISASTER_RECOVERY_GUIDE_URL =
  "https://github.com/MBombeck/HealthLog/blob/main/docs/ops/disaster-recovery.md";

/** Literal keys per platform, so the i18n coverage guard sees every one. */
function platformCopy(
  t: (key: string) => string,
  p: KitPlatform,
): { label: string; where: string } {
  switch (p) {
    case "truenas":
      return {
        label: t("admin.recoveryKit.platform.truenasLabel"),
        where: t("admin.recoveryKit.platform.truenasWhere"),
      };
    case "coolify":
      return {
        label: t("admin.recoveryKit.platform.coolifyLabel"),
        where: t("admin.recoveryKit.platform.coolifyWhere"),
      };
    case "unraid":
      return {
        label: t("admin.recoveryKit.platform.unraidLabel"),
        where: t("admin.recoveryKit.platform.unraidWhere"),
      };
    case "portainer":
      return {
        label: t("admin.recoveryKit.platform.portainerLabel"),
        where: t("admin.recoveryKit.platform.portainerWhere"),
      };
    case "compose":
      return {
        label: t("admin.recoveryKit.platform.composeLabel"),
        where: t("admin.recoveryKit.platform.composeWhere"),
      };
  }
}

function keyLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  key: KitKey,
): string {
  switch (key.kind) {
    case "application":
      return t("admin.recoveryKit.kind.application", { id: key.id });
    case "backup":
      return key.need.active
        ? t("admin.recoveryKit.kind.backup")
        : t("admin.recoveryKit.kind.backupPrevious");
    case "token":
      return t("admin.recoveryKit.kind.token");
  }
}

/** Why the kit lists a key, as short sentences. */
function KeyNeeds({ k }: { k: KitKey }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const lines: string[] = [];
  if (k.kind === "token") {
    lines.push(t("admin.recoveryKit.need.token"));
  } else if (k.kind === "backup") {
    lines.push(
      k.need.active
        ? t("admin.recoveryKit.need.backupActive")
        : t("admin.recoveryKit.need.backupPrevious"),
    );
  } else {
    if (k.need.active) lines.push(t("admin.recoveryKit.need.active"));
    else if (k.need.configured)
      lines.push(t("admin.recoveryKit.need.configured"));
    if (k.need.storedCopies > 0) {
      lines.push(
        t("admin.recoveryKit.need.storedCopies", {
          count: k.need.storedCopies,
        }),
      );
    }
    if (k.need.offhostUntil === "unknown") {
      lines.push(t("admin.recoveryKit.need.offhostUnknown"));
    } else if (k.need.offhostUntil) {
      lines.push(
        t("admin.recoveryKit.need.offhostUntil", {
          date: fmt.date(new Date(k.need.offhostUntil)),
        }),
      );
    }
  }
  lines.push(t("admin.recoveryKit.source", { variable: k.source }));
  return <p className="text-muted-foreground text-xs">{lines.join(" ")}</p>;
}

function KeyStatus({ k }: { k: KitKey }) {
  const { t } = useTranslations();
  if (k.problem === "unreadable") {
    return (
      <Badge
        variant="outline"
        className="border-destructive/40 text-destructive"
      >
        {t("admin.recoveryKit.status.unreadable")}
      </Badge>
    );
  }
  if (k.confirmed) {
    return (
      <Badge variant="outline">{t("admin.recoveryKit.status.confirmed")}</Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-warning/40 text-warning">
      {k.problem === "not_configured"
        ? t("admin.recoveryKit.status.notConfigured")
        : t("admin.recoveryKit.status.new")}
    </Badge>
  );
}

/** One row per key: what it is, its id and fingerprint, why it is listed. */
export function RecoveryKitKeyList({ kit }: { kit: RecoveryKit }) {
  const { t } = useTranslations();
  return (
    <ul
      className="divide-border divide-y rounded-lg border"
      data-testid="recovery-kit-keys"
    >
      {kit.keys.map((k) => (
        <li
          key={`${k.kind}:${k.id}`}
          className="space-y-1.5 p-3"
          data-testid={`recovery-kit-key-${k.kind}-${k.id}`}
          data-confirmed={k.confirmed ? "true" : "false"}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 text-sm font-medium">{keyLabel(t, k)}</p>
            <div className="shrink-0">
              <KeyStatus k={k} />
            </div>
          </div>
          <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-muted-foreground text-xs">
                {t("admin.recoveryKit.keyId")}
              </dt>
              <dd className="font-mono break-all">{k.id}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground text-xs">
                {t("admin.recoveryKit.fingerprint")}
              </dt>
              <dd className="font-mono" data-testid="recovery-kit-fingerprint">
                {k.fingerprint ?? t("admin.recoveryKit.noFingerprint")}
              </dd>
            </div>
          </dl>
          <KeyNeeds k={k} />
          {k.problem === "not_configured" && k.kind !== "token" ? (
            <p className="text-sm">
              {t("admin.recoveryKit.notConfiguredHint")}
            </p>
          ) : null}
          {k.problem === "unreadable" ? (
            <p className="text-sm">{t("admin.recoveryKit.unreadableHint")}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function CheckMyCopy({ kit }: { kit: RecoveryKit }) {
  const { t } = useTranslations();
  const checkable = kit.keys.filter((k) => k.fingerprint !== null);
  const [selected, setSelected] = useState(
    checkable[0] ? `${checkable[0].kind}:${checkable[0].id}` : "",
  );
  const [candidate, setCandidate] = useState("");
  const [checkResult, setCheckResult] = useState<boolean | null>(null);

  const verify = useMutation({
    // Not `apiPost`: no idempotency key, so no cached response row exists
    // for a request whose body was a key.
    mutationFn: (keyCopy: string) => {
      const target = checkable.find((k) => `${k.kind}:${k.id}` === selected);
      return apiFetch<{ matches: boolean }>("/api/admin/recovery-kit/verify", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: target?.kind,
          id: target?.id,
          keyCopy,
        }),
      });
    },
    onSuccess: (data) => {
      setCheckResult(data.matches);
      setCandidate("");
    },
    onError: (err: Error) => {
      setCheckResult(null);
      showErrorToast(err.message || t("admin.recoveryKit.checkFailed"), {
        cause: err,
      });
    },
  });

  if (checkable.length === 0) return null;
  const insecure =
    typeof window !== "undefined" && window.isSecureContext === false;

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (candidate.trim() && selected) verify.mutate(candidate);
      }}
    >
      <p className="text-sm font-medium">{t("admin.recoveryKit.checkLabel")}</p>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
        <div className="space-y-1">
          <Label htmlFor="recovery-kit-check-key" className="sr-only">
            {t("admin.recoveryKit.checkKeyLabel")}
          </Label>
          <NativeSelect
            id="recovery-kit-check-key"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setCheckResult(null);
            }}
          >
            {checkable.map((k) => (
              <option key={`${k.kind}:${k.id}`} value={`${k.kind}:${k.id}`}>
                {keyLabel(t, k)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="recovery-kit-candidate" className="sr-only">
            {t("admin.recoveryKit.checkValueLabel")}
          </Label>
          <Input
            id="recovery-kit-candidate"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={candidate}
            onChange={(e) => {
              setCandidate(e.target.value);
              setCheckResult(null);
            }}
            className="font-mono"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={!candidate.trim() || verify.isPending}
          className="min-h-11 sm:min-h-10"
        >
          {verify.isPending && (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          )}
          {t("admin.recoveryKit.checkButton")}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {insecure
          ? t("admin.recoveryKit.checkInsecureNote")
          : t("admin.recoveryKit.checkNote")}
      </p>
      {checkResult !== null && (
        <p
          role="status"
          data-testid="recovery-kit-check-result"
          className={
            checkResult ? "text-sm" : "text-destructive text-sm font-medium"
          }
        >
          {checkResult
            ? t("admin.recoveryKit.checkMatches")
            : t("admin.recoveryKit.checkNoMatch")}
        </p>
      )}
    </form>
  );
}

export function RecoveryKitCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const status = useRecoveryKit();

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.adminRecoveryKit(),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.adminRecoveryReadiness(),
      }),
    ]);

  const confirm = useMutation({
    mutationFn: (kit: RecoveryKit) =>
      apiPost<RecoveryKit>(
        "/api/admin/recovery-kit/confirm",
        {
          entries: kit.keys.map(({ kind, id, fingerprint }) => ({
            kind,
            id,
            fingerprint,
          })),
        },
        { credentials: "include" },
      ),
    onSuccess: async () => {
      toast(t("admin.recoveryKit.confirmed"));
      await invalidate();
    },
    onError: async (err: Error) => {
      if (err instanceof ApiError && err.status === 409) {
        showErrorToast(t("admin.recoveryKit.stale"), { cause: err });
        await invalidate();
        return;
      }
      showErrorToast(err.message || t("admin.recoveryKit.confirmFailed"), {
        cause: err,
      });
    },
  });

  if (!status.data) {
    return (
      <SettingsCard>
        <SettingsCardHeader
          icon={KeyRound}
          title={t("admin.recoveryKit.title")}
          description={t("admin.recoveryKit.description")}
        />
        {status.isError ? (
          <QueryErrorRow
            inset
            error={status.error}
            message={t("admin.recoveryKit.loadError")}
            onRetry={() => void status.refetch()}
          />
        ) : (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            {t("admin.recoveryKit.loading")}
          </div>
        )}
      </SettingsCard>
    );
  }

  const kit = status.data;
  const unconfirmedIds = kit.unconfirmed.map((k) => k.id).join(", ");
  return (
    <SettingsCard data-testid="recovery-kit-card">
      <SettingsCardHeader
        icon={KeyRound}
        title={t("admin.recoveryKit.title")}
        description={t("admin.recoveryKit.description")}
        status={
          kit.due ? (
            <Badge variant="outline" className="border-warning/40 text-warning">
              {t("admin.recoveryKit.badgeDue")}
            </Badge>
          ) : (
            <Badge variant="outline">{t("admin.recoveryKit.badgeDone")}</Badge>
          )
        }
      />

      <p className="text-sm">{t("admin.recoveryKit.intro")}</p>

      <RecoveryKitKeyList kit={kit} />

      <p className="text-muted-foreground text-xs">
        {t("admin.recoveryKit.fingerprintHint")}
      </p>

      <div className="space-y-2">
        <p className="text-sm font-medium">
          {t("admin.recoveryKit.whereTitle")}
        </p>
        <Tabs defaultValue={kit.platformHint}>
          <TabsList className="flex-wrap">
            {PLATFORMS.map((p) => (
              <TabsTrigger key={p} value={p}>
                {platformCopy(t, p).label}
              </TabsTrigger>
            ))}
          </TabsList>
          {PLATFORMS.map((p) => (
            <TabsContent key={p} value={p} className="text-sm">
              {platformCopy(t, p).where}
            </TabsContent>
          ))}
        </Tabs>
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium">
          {t("admin.recoveryKit.restoreTitle")}
        </p>
        <p className="text-sm">{t("admin.recoveryKit.restoreBody")}</p>
        <InlineAction asChild size="sm">
          <a
            href={DISASTER_RECOVERY_GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <BookOpen aria-hidden="true" />
            {t("admin.recoveryKit.restoreLink")}
          </a>
        </InlineAction>
      </div>

      <CheckMyCopy kit={kit} />

      {!kit.due && kit.confirmedAt && (
        <p className="text-muted-foreground text-sm">
          {kit.confirmedBy?.email
            ? t("admin.recoveryKit.confirmedAtBy", {
                date: fmt.dateTime(new Date(kit.confirmedAt)),
                who: kit.confirmedBy.email,
              })
            : t("admin.recoveryKit.confirmedAt", {
                date: fmt.dateTime(new Date(kit.confirmedAt)),
              })}
        </p>
      )}
      {kit.due && kit.confirmedAt && (
        <p className="text-sm" data-testid="recovery-kit-due-again">
          {t("admin.recoveryKit.dueAgain", {
            date: fmt.dateTime(new Date(kit.confirmedAt)),
            keys: unconfirmedIds,
          })}
        </p>
      )}

      {kit.due && (
        <SettingsCardActions>
          <Button
            size="sm"
            className="min-h-11"
            onClick={() => confirm.mutate(kit)}
            disabled={confirm.isPending}
          >
            {confirm.isPending && (
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("admin.recoveryKit.confirmButton")}
          </Button>
        </SettingsCardActions>
      )}
    </SettingsCard>
  );
}
