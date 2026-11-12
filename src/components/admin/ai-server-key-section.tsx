"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { Badge } from "@/components/ui/badge";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { PasswordInput } from "./_shared";

/**
 * v1.16.6 — operator panel for the server-wide AI key.
 *
 * The backing endpoint (`/api/admin/ai-settings`, admin-cookie-only) has
 * existed since the `admin-openai` chain fallback shipped, but it never had
 * an operator UI — configuring the shared key took a manual API call. This
 * card is its home, beside the assistant feature flags.
 *
 * Semantics worth keeping visible to the operator:
 *   - A user's own key (BYOK / Codex OAuth / local) always wins; the server
 *     key sits at the END of the provider chain as the shared fallback.
 *   - Egress over the server key is consent-gated per user
 *     (`ConsentRequiredError` in `src/lib/ai/consent-guard.ts`) — setting a
 *     key here never silently forwards anyone's health data.
 *   - The base URL is locked server-side to HTTPS + a hostname allowlist
 *     (`ADMIN_AI_BASE_URL_ALLOWLIST` extends it).
 *   - The base URL also picks the wire: an `anthropic.com` host is called on
 *     Anthropic's Messages API, every other host on the OpenAI-compatible one
 *     (`resolveAdminProvider` in `src/lib/ai/provider.ts`). `baseUrlHint` is
 *     that sentence for the operator.
 */

interface AiServerKeyResponse {
  hasKey: boolean;
  keyPreview: string | null;
  model: string;
  baseUrl: string;
  /**
   * v1.39.3 — present while the deprecated
   * `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` is set: the origins it is standing in
   * for, to copy into `AI_PRIVATE_ORIGINS`.
   */
  legacyPrivateHostGrant?: { originsInUse: string[] } | null;
}

export function AiServerKeySection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.adminAiServerKey(),
    queryFn: () => apiGet<AiServerKeyResponse>("/api/admin/ai-settings"),
  });

  const [keyDraft, setKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null);

  const modelValue = modelDraft ?? settings?.model ?? "";
  const baseUrlValue = baseUrlDraft ?? settings?.baseUrl ?? "";
  const configured = settings?.hasKey ?? false;

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiPut<AiServerKeyResponse>("/api/admin/ai-settings", payload),
    onSuccess: () => {
      setKeyDraft("");
      setModelDraft(null);
      setBaseUrlDraft(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.adminAiServerKey(),
      });
      // The server key is a provider input of the admin's own AI answer.
      void invalidateKeys(queryClient, aiInputDependentKeys);
      toast.success(t("admin.aiServerKey.saved"));
    },
    onError: (error: unknown) => {
      showErrorToast(localizedApiError(error, t, "admin.aiServerKey.error"), {
        cause: error,
      });
    },
  });

  function handleSave() {
    const payload: Record<string, unknown> = {
      model: modelValue,
      baseUrl: baseUrlValue,
    };
    if (keyDraft.trim().length > 0) {
      payload.apiKey = keyDraft.trim();
    }
    save.mutate(payload);
  }

  function handleRemove() {
    save.mutate({ apiKey: "" });
  }

  return (
    <SettingsCard data-slot="admin-ai-server-key">
      <SettingsCardHeader
        icon={KeyRound}
        title={t("admin.aiServerKey.title")}
        description={t("admin.aiServerKey.description")}
        status={
          <Badge variant={configured ? "default" : "outline"}>
            {configured
              ? t("admin.aiServerKey.statusConfigured")
              : t("admin.aiServerKey.statusNotConfigured")}
          </Badge>
        }
      />

      <div className="space-y-4">
        {settings?.legacyPrivateHostGrant ? (
          <LegacyPrivateHostNotice
            originsInUse={settings.legacyPrivateHostGrant.originsInUse}
          />
        ) : null}
        <div className="space-y-2 text-sm">
          <p>{t("admin.aiServerKey.byokHint")}</p>
          <p>{t("admin.aiServerKey.consentHint")}</p>
          <p>{t("admin.aiServerKey.baseUrlHint")}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="admin-ai-server-key-input">
            {t("admin.aiServerKey.keyLabel")}
          </Label>
          <PasswordInput
            id="admin-ai-server-key-input"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder={
              configured && settings?.keyPreview
                ? t("admin.aiServerKey.keyPlaceholderSet", {
                    preview: settings.keyPreview,
                  })
                : t("admin.aiServerKey.keyPlaceholder")
            }
            autoComplete="off"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="admin-ai-server-key-model">
              {t("admin.aiServerKey.modelLabel")}
            </Label>
            <Input
              id="admin-ai-server-key-model"
              value={modelValue}
              onChange={(e) => setModelDraft(e.target.value)}
              placeholder="gpt-4o"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-ai-server-key-base-url">
              {t("admin.aiServerKey.baseUrlLabel")}
            </Label>
            <Input
              id="admin-ai-server-key-base-url"
              value={baseUrlValue}
              onChange={(e) => setBaseUrlDraft(e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </div>
        </div>

        <SettingsCardActions>
          {configured && (
            <ConfirmButton
              slot="admin-ai-server-key-remove"
              destructive
              variant="outline"
              size="sm"
              label={t("admin.aiServerKey.remove")}
              title={t("admin.aiServerKey.removeTitle")}
              body={t("admin.aiServerKey.removeBody")}
              confirmLabel={t("admin.aiServerKey.removeConfirm")}
              pending={save.isPending}
              onConfirm={handleRemove}
            />
          )}
          <Button
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={handleSave}
            disabled={save.isPending}
            data-slot="admin-ai-server-key-save"
          >
            {save.isPending && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("admin.aiServerKey.save")}
          </Button>
        </SettingsCardActions>
      </div>
    </SettingsCard>
  );
}

/**
 * v1.39.3 — the deprecated `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true`, with the exact
 * line to set instead. The origins come from the saved base URLs on this
 * instance; the operator copies the line into the server environment.
 */
function LegacyPrivateHostNotice({ originsInUse }: { originsInUse: string[] }) {
  const { t } = useTranslations();
  const line = `AI_PRIVATE_ORIGINS="${originsInUse.join(",")}"`;
  return (
    <div
      role="status"
      data-slot="admin-ai-legacy-private-hosts"
      className="border-warning/40 bg-warning/10 rounded-md border px-3 py-2 text-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">
            {t("admin.aiServerKey.legacyGrantTitle")}
          </p>
          <p>{t("admin.aiServerKey.legacyGrantBody")}</p>
          {originsInUse.length > 0 ? (
            <>
              <p>{t("admin.aiServerKey.legacyGrantOrigins")}</p>
              <code
                data-slot="admin-ai-legacy-private-hosts-line"
                className="bg-muted block overflow-x-auto rounded px-2 py-1 font-mono text-xs break-all select-all"
              >
                {line}
              </code>
            </>
          ) : (
            <p>{t("admin.aiServerKey.legacyGrantNoOrigins")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
