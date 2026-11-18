"use client";

/**
 * Interactive dialog to connect Antigravity CLI via Google OAuth.
 *
 * It initiates the Google OAuth flow via `/api/antigravity/auth/start`, presents
 * a link for the user to open in their browser, and provides an input where the
 * user pastes the resulting authorization code or callback URL.
 *
 * Zero terminal / docker exec steps required.
 */
import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";

interface AntigravityConnectDialogProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

export function AntigravityConnectDialog({
  open,
  onClose,
  onConnected,
}: AntigravityConnectDialogProps) {
  // One login per opening. The state starts fresh each time the dialog opens.
  if (!open) return null;
  return <ConnectSession onClose={onClose} onConnected={onConnected} />;
}

function ConnectSession({
  onClose,
  onConnected,
}: Pick<AntigravityConnectDialogProps, "onClose" | "onConnected">) {
  const { t } = useTranslations();

  // Errors are kept raw and translated at render time. That keeps the effect
  // free of translation state.
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [initError, setInitError] = useState<unknown>(null);

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiPost<{ authUrl: string }>("/api/antigravity/auth/start")
      .then((res) => {
        if (active) setAuthUrl(res.authUrl);
      })
      .catch((err: unknown) => {
        if (active) setInitError(err);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  const retry = () => {
    setLoading(true);
    setInitError(null);
    setAuthUrl(null);
    setAttempt((n) => n + 1);
  };

  const handleCancel = () => {
    apiPost("/api/antigravity/auth/cancel").catch(() => {
      // ignore cancellation errors
    });
    onClose();
  };

  const handleSubmit = async () => {
    const trimmed = code.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      await apiPost("/api/antigravity/auth/submit", { code: trimmed });
      onConnected();
      onClose();
    } catch (err) {
      setSubmitError(
        localizedApiError(err, t, "settings.ai.antigravity.connectError"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) handleCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("settings.ai.antigravity.connectDialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("settings.ai.antigravity.connectDialogDescription")}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex flex-col items-center justify-center space-y-3 py-6">
            <Loader2 className="text-muted-foreground h-6 w-6 animate-spin motion-reduce:animate-none" />
            <p className="text-muted-foreground text-sm">
              {t("settings.ai.antigravity.connectGeneratingLink")}
            </p>
          </div>
        )}

        {initError != null && !loading && (
          <div className="space-y-4 py-2">
            <div className="bg-destructive/15 text-destructive rounded-md p-3 text-sm">
              {localizedApiError(
                initError,
                t,
                "settings.ai.antigravity.connectError",
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={handleCancel}>
                {t("common.cancel")}
              </Button>
              <Button onClick={retry}>
                {t("settings.ai.antigravity.connectTryAgain")}
              </Button>
            </div>
          </div>
        )}

        {authUrl && !loading && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t("settings.ai.antigravity.connectStep1")}
              </p>
              <Button
                asChild
                variant="outline"
                className="w-full justify-center gap-2"
              >
                <a href={authUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t("settings.ai.antigravity.connectStep1Button")}
                </a>
              </Button>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t("settings.ai.antigravity.connectStep2")}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("settings.ai.antigravity.connectStep2Description")}
              </p>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t(
                  "settings.ai.antigravity.connectCodePlaceholder",
                )}
                disabled={submitting}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && code.trim() && !submitting) {
                    void handleSubmit();
                  }
                }}
              />
            </div>

            {submitError && (
              <div className="bg-destructive/15 text-destructive rounded-md p-3 text-sm">
                {submitError}
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                variant="ghost"
                onClick={handleCancel}
                disabled={submitting}
              >
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => void handleSubmit()}
                disabled={!code.trim() || submitting}
              >
                {submitting && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                )}
                {submitting
                  ? t("settings.ai.antigravity.connectConnecting")
                  : t("settings.ai.antigravity.connectSubmitButton")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
