"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, LifeBuoy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import type { IntegrationStatusEnvelope } from "@/components/settings/integrations/shared";
import { fetchMe, isFullAccount, useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { recentErrorIds } from "@/lib/errors/error-id";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { buildSupportInfo } from "@/lib/support/support-info";

interface VersionPayload {
  version: string;
  buildSha: string | null;
}

/**
 * Settings, About: "Copy support info". Puts together what a bug report needs
 * from reads the app already makes (build, language, time zone, modules, AI
 * state, each connection's health, the last error ids of this session) and
 * copies it as plain text. No new route, nothing leaves the browser until the
 * person pastes it somewhere. See `src/lib/support/support-info.ts`.
 */
export function SupportInfoCard() {
  const { t, locale } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    setBusy(true);
    try {
      const [version, integrations] = await Promise.all([
        queryClient
          .fetchQuery({
            queryKey: queryKeys.apiVersion(),
            queryFn: async () => apiGet<VersionPayload>("/api/version"),
            staleTime: Infinity,
          })
          .catch(() => null),
        queryClient
          .fetchQuery({
            queryKey: queryKeys.integrationsStatus(),
            queryFn: async () =>
              apiGet<IntegrationStatusEnvelope>("/api/integrations/status"),
          })
          .catch(() => null),
      ]);
      // The scrubber needs the account's own name and email as known values;
      // the server-rendered seed withholds the name, so ask for the full
      // account when the shell's own read has not landed yet.
      const me = isFullAccount(user)
        ? user
        : await queryClient
            .fetchQuery({ queryKey: queryKeys.authMe(), queryFn: fetchMe })
            .catch(() => user);
      const text = buildSupportInfo({
        version,
        me: me
          ? {
              id: me.id,
              username: me.username,
              email: me.email,
              fullName: me.fullName,
              timezone: me.timezone,
              modules: me.modules,
              ai: me.ai ?? null,
            }
          : null,
        locale,
        connections: integrations?.integrations ?? null,
        recentErrorIds: recentErrorIds(),
        client: {
          userAgent:
            typeof navigator !== "undefined" ? navigator.userAgent : null,
          standalone:
            typeof window !== "undefined" &&
            typeof window.matchMedia === "function" &&
            window.matchMedia("(display-mode: standalone)").matches,
        },
        generatedAt: new Date().toISOString(),
      });
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        window.prompt(t("settings.about.support.copy"), text);
      }
    } catch (failure) {
      showErrorToast(t("settings.about.support.copyFailed"), {
        cause: failure,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={LifeBuoy}
        title={t("settings.about.support.title")}
        description={t("settings.about.support.description")}
      />
      <SettingsCardActions>
        <Button
          size="sm"
          onClick={() => void copy()}
          disabled={busy}
          aria-live="polite"
        >
          <Copy className="size-4" aria-hidden="true" />
          {copied
            ? t("settings.about.support.copied")
            : t("settings.about.support.copy")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
