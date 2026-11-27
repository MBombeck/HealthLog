"use client";

/**
 * Settings → Integrations → Document archives (#1038): connect Paperless-ngx or
 * Papra so the document picker can search it.
 *
 * Renders nothing unless the operator listed at least one origin in
 * `DOCUMENT_SOURCE_ORIGINS`, the documents module is on, and the person is in
 * their own record: a delegate never manages the owner's connection, and a
 * card that can only be refused advertises a feature that is not there.
 *
 * One form per system behind a switch. Save tests the connection before it is
 * stored and says why when it fails; the token field never shows the stored
 * token (the server never returns it), only that one is saved, and leaving it
 * empty keeps it. Results sit above the action row; nothing follows it
 * (UI standards §12).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, Check, Loader2, Unlink } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { StatusChip } from "@/components/ui/status-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { Segmented } from "@/components/ui/segmented";
import {
  errorCodeOf,
  sourceErrorMessage,
} from "@/components/documents/sources/source-errors";
import {
  systemName,
  useDocumentSourcesStatus,
} from "@/components/documents/sources/use-document-sources";
import { apiDelete, apiPost, apiPut } from "@/lib/api/api-fetch";
import {
  DOCUMENT_PICKER_SYSTEMS,
  slugForSystem,
  type DocumentPickerSystem,
  type DocumentSourceConnectionDto,
} from "@/lib/documents/sources/types";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";

type Outcome = { tone: "success" | "error"; message: string } | null;

export function DocumentSourcesCard() {
  const { t } = useTranslations();
  const { ownRecord, eligible, query } = useDocumentSourcesStatus();
  const [picked, setPicked] = useState<DocumentPickerSystem>("PAPERLESS");

  const data = query.data;
  const connections = data?.connections ?? [];
  // Editing needs the operator's list and the documents module. Without
  // either, a connection that is still stored stays on the card so its token
  // can be deleted; with none stored there is nothing to show.
  const editable = eligible && data?.available === true;
  if (!ownRecord || !data || (!editable && connections.length === 0)) {
    return null;
  }

  const options: readonly DocumentPickerSystem[] = editable
    ? DOCUMENT_PICKER_SYSTEMS
    : connections.map((c) => c.system);
  const system = options.includes(picked) ? picked : options[0];

  return (
    <SettingsCard data-testid="document-sources-card">
      <SettingsCardHeader
        icon={Archive}
        title={t("settings.documentSources.title")}
        description={t("settings.documentSources.description")}
        status={<StatusChip tone={connections.length > 0 ? "active" : "off"} />}
      />

      <p className="text-sm">
        {editable
          ? t("settings.documentSources.explainer")
          : eligible
            ? t("settings.documentSources.unavailableExplainer")
            : t("settings.documentSources.moduleOffExplainer")}
      </p>

      {options.length > 1 ? (
        <Segmented
          options={options.map((option) => ({
            value: option,
            label: systemName(option),
            trailing: connections.some((c) => c.system === option) ? (
              <Check
                className="size-3.5"
                aria-label={t("settings.documentSources.statusConnected")}
              />
            ) : null,
          }))}
          value={system}
          onChange={setPicked}
          label={t("settings.documentSources.systemLabel")}
          slot="document-sources-system"
          className="self-start"
        />
      ) : null}

      <SourceForm
        // A fresh form per system: nothing typed for one leaks into the other.
        key={system}
        system={system}
        connection={connections.find((c) => c.system === system) ?? null}
        allowedOrigins={data.allowedOrigins}
        editable={editable}
      />
    </SettingsCard>
  );
}

/** The origin of an address, or null while it is not one yet. */
function originOf(value: string): string | null {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

function SourceForm({
  system,
  connection,
  allowedOrigins,
  editable,
}: {
  system: DocumentPickerSystem;
  connection: DocumentSourceConnectionDto | null;
  allowedOrigins: string[];
  /** False when only removing the stored connection is possible. */
  editable: boolean;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const queryClient = useQueryClient();
  const slug = slugForSystem(system);
  const isPapra = system === "PAPRA";

  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [organizationId, setOrganizationId] = useState(
    connection?.organizationId ?? "",
  );
  const [token, setToken] = useState("");
  const [outcome, setOutcome] = useState<Outcome>(null);

  const dirty =
    baseUrl.trim() !== (connection?.baseUrl ?? "") ||
    (isPapra && organizationId.trim() !== (connection?.organizationId ?? "")) ||
    token.trim() !== "";

  const refresh = () =>
    invalidateKeys(queryClient, [queryKeys.documentSources()]);

  const save = useMutation({
    mutationFn: () =>
      apiPut<DocumentSourceConnectionDto>(`/api/documents/sources/${slug}`, {
        baseUrl: baseUrl.trim(),
        ...(isPapra ? { organizationId: organizationId.trim() } : {}),
        ...(token.trim() ? { token: token.trim() } : {}),
      }),
    onMutate: () => setOutcome(null),
    onSuccess: () => {
      setToken("");
      setOutcome({
        tone: "success",
        message: t("settings.documentSources.saved"),
      });
      void refresh();
    },
    onError: (err) =>
      setOutcome({
        tone: "error",
        message: sourceErrorMessage(t, errorCodeOf(err)),
      }),
  });

  const test = useMutation({
    mutationFn: () =>
      apiPost<{ ok: true; latencyMs: number }>(
        `/api/documents/sources/${slug}/test`,
      ),
    onMutate: () => setOutcome(null),
    onSuccess: (data) => {
      setOutcome({
        tone: "success",
        message: t("settings.documentSources.testOk", {
          latency: data.latencyMs,
        }),
      });
      void refresh();
    },
    onError: (err) =>
      setOutcome({
        tone: "error",
        message: sourceErrorMessage(t, errorCodeOf(err)),
      }),
  });

  const disconnect = useMutation({
    mutationFn: () => apiDelete(`/api/documents/sources/${slug}`),
    onSuccess: () => {
      setBaseUrl("");
      setOrganizationId("");
      setToken("");
      setOutcome(null);
      void refresh();
    },
    onError: (err) =>
      setOutcome({
        tone: "error",
        message: sourceErrorMessage(t, errorCodeOf(err)),
      }),
  });

  const busy = save.isPending || test.isPending || disconnect.isPending;
  // The stored token is reused only on the address's own origin; the server
  // refuses to send it anywhere else, so the form asks for it again.
  const keepsToken =
    connection !== null &&
    originOf(baseUrl) !== null &&
    originOf(baseUrl) === originOf(connection.baseUrl);
  const canSave =
    editable &&
    baseUrl.trim() !== "" &&
    (!isPapra || organizationId.trim() !== "") &&
    (keepsToken || token.trim() !== "") &&
    dirty;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave && !busy) save.mutate();
      }}
      data-slot="document-sources-form"
    >
      <p
        className="text-muted-foreground text-xs"
        data-slot="document-sources-state"
      >
        {connection
          ? connection.lastVerifiedAt
            ? t("settings.documentSources.connectedSince", {
                date: format.date(connection.lastVerifiedAt),
              })
            : t("settings.documentSources.statusConnected")
          : t("settings.documentSources.statusNotConnected")}
      </p>

      {editable && connection && !connection.originAllowed ? (
        <p
          role="alert"
          className="border-warning/30 bg-warning/10 text-foreground rounded-md border px-3 py-2 text-sm"
        >
          {t("settings.documentSources.originRemoved")}
        </p>
      ) : null}

      {editable ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={`document-source-url-${slug}`}>
              {t("settings.documentSources.baseUrl")}
            </Label>
            <Input
              id={`document-source-url-${slug}`}
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={allowedOrigins[0] ?? "https://"}
              maxLength={2048}
              autoComplete="off"
              inputMode="url"
              spellCheck={false}
              autoCapitalize="none"
            />
            <p className="text-muted-foreground text-xs">
              {t("settings.documentSources.allowedOrigins", {
                origins: allowedOrigins.join(", "),
              })}
            </p>
          </div>

          {isPapra ? (
            <div className="space-y-1.5">
              <Label htmlFor="document-source-org">
                {t("settings.documentSources.organizationId")}
              </Label>
              <Input
                id="document-source-org"
                value={organizationId}
                onChange={(e) => setOrganizationId(e.target.value)}
                maxLength={128}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
              />
              <p className="text-muted-foreground text-xs">
                {t("settings.documentSources.organizationHelp")}
              </p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor={`document-source-token-${slug}`}>
              {t("settings.documentSources.token")}
            </Label>
            <PasswordInput
              id={`document-source-token-${slug}`}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                keepsToken
                  ? t("settings.documentSources.tokenSaved")
                  : undefined
              }
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
            />
            <p className="text-muted-foreground text-xs">
              {isPapra
                ? t("settings.documentSources.tokenHelpPapra")
                : t("settings.documentSources.tokenHelpPaperless")}
            </p>
            {connection && !keepsToken && baseUrl.trim() !== "" ? (
              <p
                className="text-muted-foreground text-xs"
                data-slot="document-sources-token-again"
              >
                {t("settings.documentSources.tokenNewAddress")}
              </p>
            ) : null}
          </div>
        </>
      ) : connection ? (
        <p className="text-sm break-all" data-slot="document-sources-address">
          {connection.baseUrl}
        </p>
      ) : null}

      {outcome ? (
        <WrittenOutcomeLine
          outcome={outcome.tone === "error" ? "failed" : "success"}
          message={outcome.message}
          testId="document-sources-outcome"
        />
      ) : null}

      <SettingsCardActions>
        {connection ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
              >
                <Unlink className="size-4" aria-hidden />
                {t("settings.documentSources.disconnect")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("settings.documentSources.disconnectTitle", {
                    name: systemName(system),
                  })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.documentSources.disconnectDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => disconnect.mutate()}>
                  {t("settings.documentSources.disconnect")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
        {connection && editable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || dirty || !connection.originAllowed}
            onClick={() => test.mutate()}
          >
            {test.isPending ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : null}
            {t("settings.documentSources.test")}
          </Button>
        ) : null}
        {editable ? (
          <Button type="submit" size="sm" disabled={busy || !canSave}>
            {save.isPending ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : null}
            {save.isPending
              ? t("settings.documentSources.saving")
              : t("settings.documentSources.save")}
          </Button>
        ) : null}
      </SettingsCardActions>
    </form>
  );
}
