"use client";

import { useState, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, Upload, X, CheckCircle2, ImageIcon, Bug } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";

export default function BugReportPage() {
  const { isAuthenticated } = useAuth();
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotName, setScreenshotName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslations();

  async function handleScreenshot(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setResult({ type: "error", message: t("bugreport.imageOnly") });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setResult({
        type: "error",
        message: t("bugreport.tooLarge"),
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setScreenshot(reader.result as string);
      setScreenshotName(file.name);
    };
    reader.readAsDataURL(file);
  }

  function removeScreenshot() {
    setScreenshot(null);
    setScreenshotName(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    setLoading(true);

    try {
      const res = await fetch("/api/bugreport", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          ...(screenshot ? { screenshot } : {}),
        }),
      });

      const json = await res.json();
      if (res.ok) {
        setResult({
          type: "success",
          message: t("bugreport.success"),
        });
        setDescription("");
        removeScreenshot();
      } else {
        setResult({
          type: "error",
          message: json.error || t("bugreport.errorCreating"),
        });
      }
    } catch {
      setResult({ type: "error", message: t("common.networkError") });
    } finally {
      setLoading(false);
    }
  }

  if (!isAuthenticated) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("bugreport.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("bugreport.loginRequired")}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("bugreport.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("bugreport.subtitle")}
        </p>
      </div>

      <div className="bg-card border-border w-full rounded-xl border p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bug-desc">{t("bugreport.description")}</Label>
            <textarea
              id="bug-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder=""
              required
              minLength={10}
              maxLength={5000}
              rows={9}
              className="border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
          </div>

          <div className="space-y-2">
            <Label>{t("bugreport.screenshot")}</Label>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={handleScreenshot}
              className="hidden"
            />
            {screenshot ? (
              <div className="bg-muted/50 relative rounded-lg p-3">
                <div className="flex items-center gap-2">
                  <ImageIcon className="text-muted-foreground h-4 w-4" />
                  <span className="flex-1 truncate text-sm">
                    {screenshotName}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={removeScreenshot}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={screenshot}
                  alt={t("bugreport.screenshotPreview")}
                  className="mt-2 max-h-48 rounded border object-contain"
                />
              </div>
            ) : null}
          </div>

          {result && (
            <div
              className={`rounded-lg p-3 text-sm ${
                result.type === "success"
                  ? "bg-dracula-green/10 text-dracula-green"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              {result.type === "success" && (
                <CheckCircle2 className="mr-2 inline h-4 w-4" />
              )}
              {result.message}
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="mr-2 h-4 w-4" />
              {t("bugreport.attachScreenshot")}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <Bug className="mr-2 h-4 w-4" />
              {t("bugreport.submit")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
