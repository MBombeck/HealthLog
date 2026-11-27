"use client";

/**
 * Settings → Export & Import → Health Connect from a folder.
 *
 * Health Connect's scheduled export writes its ZIP into a cloud folder again
 * and again. Here a person names that folder (WebDAV, or Nextcloud's WebDAV
 * address) and an app password, and HealthLog fetches the file about every
 * six hours and imports anything new through the Health Connect importer.
 * The password is never shown again; the card shows the last attempt as a
 * translated outcome.
 */
import { CONFIRM_SAVED } from "@/lib/api/mutation-feedback";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudDownload, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusChip } from "@/components/ui/status-chip";
import { SwitchRow } from "@/components/ui/switch-row";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
} from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  recentProofErrorMessage,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";
import { CardQueryBody } from "@/components/settings/_card-query-body";
import { ImportCardShell } from "./import-card-shell";

interface RemoteState {
  source: {
    folderUrl: string;
    fileName: string;
    enabled: boolean;
    lastAttemptAt: string | null;
    lastOutcome: string | null;
    nextAttemptAt: string;
  } | null;
}

const ROUTE = "/api/import/health-connect-remote";

function useOutcomeLabels() {
  const { t } = useTranslations();
  const k = "settings.sections.export.import.healthConnectRemote.outcome";
  return {
    imported: t(`${k}.imported`),
    unchanged: t(`${k}.unchanged`),
    busy: t(`${k}.busy`),
    not_found: t(`${k}.notFound`),
    unauthorized: t(`${k}.unauthorized`),
    redirected: t(`${k}.redirected`),
    upstream_error: t(`${k}.upstreamError`),
    too_large: t(`${k}.tooLarge`),
    timeout: t(`${k}.timeout`),
    network: t(`${k}.network`),
    private_origin_not_approved: t(`${k}.privateOrigin`),
    invalid_origin: t(`${k}.invalidUrl`),
    no_worker: t(`${k}.noWorker`),
  } as Record<string, string>;
}

/** The sentence for a refused save, by the route's error code. */
function remoteErrorText(err: unknown, t: (key: string) => string): string {
  const k = "settings.sections.export.import.healthConnectRemote";
  const code =
    err instanceof ApiError && typeof err.meta?.errorCode === "string"
      ? err.meta.errorCode
      : null;
  if (code === "import.health_connect.remote.private_origin_not_approved") {
    return t(`${k}.error.privateOrigin`);
  }
  if (code === "import.health_connect.remote.invalid_url") {
    return t(`${k}.error.invalidUrl`);
  }
  if (code === "import.health_connect.remote.https_required") {
    return t(`${k}.error.httpsRequired`);
  }
  if (code === "import.health_connect.remote.password_required") {
    return t(`${k}.error.passwordRequired`);
  }
  return t(`${k}.error.saveFailed`);
}

export function HealthConnectRemoteCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const outcomes = useOutcomeLabels();
  const queryClient = useQueryClient();
  const k = "settings.sections.export.import.healthConnectRemote";
  const key = queryKeys.healthConnectRemote();
  const state = useQuery({
    queryKey: key,
    queryFn: () => apiGet<RemoteState>(ROUTE),
  });
  const source = state.data?.source ?? null;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const errorText = (err: unknown) => remoteErrorText(err, t);
  const done = () => {
    setError(null);
    void queryClient.invalidateQueries({ queryKey: key });
  };
  // A save that writes the password asks for a fresh proof; the hook opens
  // the re-proof dialog on that refusal and retries.
  const recentProof = useRecentProof();
  const save = useMutation({
    meta: CONFIRM_SAVED,
    mutationFn: (body: Record<string, unknown>) =>
      recentProof.run(() =>
        apiPut<RemoteState>("/api/import/health-connect-remote", body),
      ),
    onSuccess: done,
    onError: (err) => setError(recentProofErrorMessage(err, errorText(err))),
  });
  const fetchNow = useMutation({
    mutationFn: () => apiPost(`${ROUTE}/fetch`, {}),
    // The fetch runs in the background; its outcome lands on this card.
    onSuccess: () => {
      done();
      toastWrittenOutcome("success", t(`${k}.fetchStarted`));
    },
    onError: () => setError(t(`${k}.error.fetchFailed`)),
  });
  const remove = useMutation({
    mutationFn: () => apiDelete(ROUTE),
    onSuccess: () => {
      done();
      toastWrittenOutcome("success", t(`${k}.removed`));
    },
    onError: () => setError(t(`${k}.error.removeFailed`)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    save.mutate({
      folderUrl: String(form.get("folderUrl") ?? ""),
      fileName: String(form.get("fileName") ?? "") || "Health Connect.zip",
      username: String(form.get("username") ?? ""),
      ...(password ? { password } : {}),
      enabled: enabled ?? source?.enabled ?? true,
    });
  }

  const busy = save.isPending || fetchNow.isPending || remove.isPending;
  return (
    <ImportCardShell
      testId="import-card-health-connect-remote"
      anchor="import-health-connect-remote"
      icon={CloudDownload}
      title={t(`${k}.title`)}
      description={t(`${k}.description`)}
      foldLabel={t("settings.integrationCard.setUp")}
      status={
        state.data ? (
          <StatusChip tone={source?.enabled ? "active" : "off"} />
        ) : null
      }
    >
      {recentProof.dialog}
      <CardQueryBody query={state} slot="hc-remote-state">
        <form
          className="space-y-3"
          onSubmit={submit}
          key={source?.folderUrl ?? "new"}
        >
          <div className="grid gap-1 text-sm">
            <Label htmlFor="hc-remote-url">{t(`${k}.folderUrl`)}</Label>
            <Input
              id="hc-remote-url"
              name="folderUrl"
              type="url"
              required
              defaultValue={source?.folderUrl ?? ""}
              placeholder="https://cloud.example/remote.php/dav/files/me/Health"
            />
          </div>
          <div className="grid gap-1 text-sm">
            <Label htmlFor="hc-remote-file">{t(`${k}.fileName`)}</Label>
            <Input
              id="hc-remote-file"
              name="fileName"
              defaultValue={source?.fileName ?? "Health Connect.zip"}
            />
          </div>
          <div className="grid gap-1 text-sm">
            <Label htmlFor="hc-remote-user">{t(`${k}.username`)}</Label>
            <Input
              id="hc-remote-user"
              name="username"
              required
              autoComplete="off"
            />
          </div>
          <div className="grid gap-1 text-sm">
            <Label htmlFor="hc-remote-password">{t(`${k}.password`)}</Label>
            <Input
              id="hc-remote-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required={!source}
              placeholder={source ? t(`${k}.passwordKept`) : undefined}
            />
          </div>
          <SwitchRow
            label={t(`${k}.enabled`)}
            id="hc-remote-enabled"
            checked={enabled ?? source?.enabled ?? true}
            onCheckedChange={setEnabled}
          />
          <p className="text-muted-foreground text-xs">
            {t(`${k}.privacyNote`)}
          </p>
          {source?.lastAttemptAt && (
            <p className="text-foreground text-xs" data-testid="hc-remote-last">
              {t(`${k}.lastAttempt`, {
                when: fmt.dateTime(new Date(source.lastAttemptAt)),
                outcome:
                  outcomes[source.lastOutcome ?? ""] ??
                  t(`${k}.outcome.unknown`),
              })}
            </p>
          )}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <SettingsCardActions className="mt-auto">
            {source && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => fetchNow.mutate()}
                >
                  {t(`${k}.fetchNow`)}
                </Button>
                <ConfirmButton
                  slot="hc-remote-remove"
                  destructive
                  size="sm"
                  label={t(`${k}.remove`)}
                  title={t(`${k}.removeTitle`)}
                  body={t(`${k}.removeBody`)}
                  confirmLabel={t(`${k}.remove`)}
                  pending={remove.isPending}
                  onConfirm={() => remove.mutate()}
                />
              </>
            )}
            <Button type="submit" size="sm" disabled={busy}>
              {save.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {t("common.save")}
            </Button>
          </SettingsCardActions>
        </form>
      </CardQueryBody>
    </ImportCardShell>
  );
}
