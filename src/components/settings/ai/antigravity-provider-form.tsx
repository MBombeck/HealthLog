"use client";

/**
 * Antigravity CLI provider card for Settings, AI.
 *
 * Shows whether the CLI is installed and the state of the user's profile. The
 * connection test starts the CLI on that profile and sends no health data. The
 * login connects via an interactive Google OAuth dialog right from the browser.
 * Once connected, the card lists the models the CLI offers and saves the
 * user's choice.
 */

import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import type { ReasoningEffort } from "./shared";
import { ReasoningEffortField } from "./reasoning-effort-field";
import { AntigravityModelPicker } from "./antigravity-model-picker";
import { AntigravityConnectDialog } from "./antigravity-connect-dialog";
import { CliInstallRow, ConnectionStateRow } from "./antigravity-status-rows";
import { reasonText, useAntigravityProfile } from "./use-antigravity-profile";

export function AntigravityProviderForm({
  onProviderChanged,
}: {
  onProviderChanged?: () => void;
}) {
  const { t } = useTranslations();
  const profile = useAntigravityProfile({ onProviderChanged });
  const { status, loading, loadFailed, busy, notice, models, connected } =
    profile;

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" />
        </CardContent>
      </Card>
    );
  }

  if (loadFailed || !status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.ai.antigravity.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-destructive text-sm">
            {t("settings.ai.antigravity.reasonFailed")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.ai.antigravity.title")}</CardTitle>
          <CardDescription>
            {t("settings.ai.antigravity.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <CliInstallRow
            installed={status.cliInstalled}
            version={status.cliVersion}
          />
          {!status.cliInstalled && !status.canInstallCli && (
            <p className="text-muted-foreground text-sm">
              {t("settings.ai.antigravity.installAdminOnly")}
            </p>
          )}
          {status.cliInstalled && status.cliManaged === false && (
            <p className="text-muted-foreground text-sm">
              {t("settings.ai.antigravity.cliExternallyManaged")}
            </p>
          )}
          {status.cliInstalled &&
            status.cliManaged &&
            status.updateAvailable &&
            !status.canInstallCli && (
              <p className="text-muted-foreground text-sm">
                {t("settings.ai.antigravity.updateAdminOnly")}
              </p>
            )}
          <ConnectionStateRow
            connection={status.connectionStatus}
            connectedAt={status.connectedAt}
          />

          {notice && (
            <p role="status" className="text-muted-foreground text-sm">
              {notice}
            </p>
          )}

          {connected && models && (
            <>
              <AntigravityModelPicker
                models={models.models}
                selectedModel={models.selectedModel}
                disabled={busy !== null}
                emptyText={reasonText(t, models.reason ?? "no_models")}
                onChange={(model) => void profile.changeModel(model)}
              />
              {(() => {
                const validLevels: ReasoningEffort[] = [
                  "low",
                  "medium",
                  "high",
                ];
                const filteredLevels = (models.thoughtLevels ?? []).filter(
                  (lvl): lvl is ReasoningEffort =>
                    validLevels.includes(lvl as ReasoningEffort),
                );
                if (filteredLevels.length === 0) return null;

                const candidate =
                  profile.reasoning === "none" ? "low" : profile.reasoning;
                const currentValue =
                  candidate && filteredLevels.includes(candidate)
                    ? candidate
                    : null;

                return (
                  <ReasoningEffortField
                    id="settings-ai-antigravity-reasoning"
                    disabled={busy !== null || !profile.antigravityEnabled}
                    value={currentValue}
                    onChange={(next) => void profile.changeReasoning(next)}
                    allowedLevels={filteredLevels}
                    showDefault={true}
                  />
                );
              })()}
            </>
          )}

          <div className="flex flex-wrap gap-2">
            {!status.cliInstalled &&
            !status.canInstallCli ? null : !status.cliInstalled ? (
              <Button
                onClick={() => void profile.installCli()}
                disabled={busy !== null}
                aria-busy={busy === "install" || undefined}
              >
                {busy === "install" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                    {t("settings.ai.antigravity.installingCli")}
                  </>
                ) : (
                  t("settings.ai.antigravity.installCliButton")
                )}
              </Button>
            ) : !connected ? (
              <Button
                onClick={() => profile.openConnect()}
                disabled={busy !== null}
              >
                {t("settings.ai.antigravity.connectButton")}
              </Button>
            ) : (
              <ConfirmButton
                slot="settings-ai-antigravity-disconnect"
                destructive
                variant="destructive"
                label={t("settings.ai.antigravity.disconnectButton")}
                title={t("settings.ai.antigravity.disconnectTitle")}
                body={t("settings.ai.antigravity.disconnectBody")}
                confirmLabel={t("settings.ai.antigravity.disconnectConfirm")}
                pending={busy === "disconnect"}
                onConfirm={() => void profile.disconnect()}
              />
            )}

            {status.cliInstalled && status.canUpdateCli && (
              <Button
                variant="outline"
                onClick={() => void profile.updateCli()}
                disabled={busy !== null}
                aria-busy={busy === "update" || undefined}
              >
                {busy === "update" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                    {t("settings.ai.antigravity.updatingCli")}
                  </>
                ) : (
                  t("settings.ai.antigravity.updateCliButton")
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <AntigravityConnectDialog
        open={profile.connectOpen}
        onClose={profile.closeConnect}
        onConnected={() => void profile.handleConnected()}
      />
    </>
  );
}
