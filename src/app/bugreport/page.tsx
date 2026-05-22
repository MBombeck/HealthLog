"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, CheckCircle2, Bug, GitPullRequest, Info } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface BugReportStatus {
  configured: boolean;
  enabled: boolean;
  isAdmin: boolean;
}

const CATEGORIES = [
  { value: "BUG", labelKey: "bugreport.categoryBug" },
  { value: "FEATURE_REQUEST", labelKey: "bugreport.categoryFeature" },
  { value: "QUESTION", labelKey: "bugreport.categoryQuestion" },
  { value: "OTHER", labelKey: "bugreport.categoryOther" },
] as const;

type CategoryValue = (typeof CATEGORIES)[number]["value"];

export default function BugReportPage() {
  const { isAuthenticated } = useAuth();
  const { t, locale } = useTranslations();
  const [category, setCategory] = useState<CategoryValue>("BUG");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Status is now informational only — submission always works.
  const { data: status } = useQuery({
    queryKey: queryKeys.bugreportStatus(),
    queryFn: async () => {
      const res = await fetch("/api/bugreport/status");
      if (!res.ok) throw new Error("Failed to load status");
      const json = await res.json();
      return json.data as BugReportStatus;
    },
    enabled: isAuthenticated,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    setLoading(true);

    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          subject: subject || description.slice(0, 60),
          description,
          metadata: {
            locale,
            userAgent:
              typeof navigator !== "undefined" ? navigator.userAgent : null,
            url:
              typeof window !== "undefined" ? window.location.pathname : null,
          },
        }),
      });

      const json = await res.json();
      if (res.ok) {
        setResult({ type: "success", message: t("bugreport.success") });
        setSubject("");
        setDescription("");
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
      <div className="w-full space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("bugreport.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("bugreport.loginRequired")}
        </p>
      </div>
    );
  }

  if (status && status.enabled === false) {
    return (
      <div className="w-full space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("bugreport.title")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("bugreport.subtitle")}
          </p>
        </div>
        <div className="bg-card border-border border-l-dracula-orange flex gap-2 rounded-lg border-l-4 p-3 text-sm">
          <Info className="text-dracula-orange mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="text-foreground font-medium">
              {t("bugreport.disabledTitle")}
            </p>
            <p className="text-muted-foreground mt-1">
              {t("bugreport.disabledBody")}
            </p>
          </div>
        </div>
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

      {status?.configured && (
        <div className="bg-card border-border border-l-dracula-cyan flex gap-2 rounded-lg border-l-4 p-3 text-sm">
          <GitPullRequest className="text-dracula-cyan mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-muted-foreground">
            {t("bugreport.githubEscalationNote")}
          </p>
        </div>
      )}
      {!status?.configured && (
        <div className="bg-card border-border border-l-dracula-purple flex gap-2 rounded-lg border-l-4 p-3 text-sm">
          <Info className="text-dracula-purple mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-muted-foreground">
            {t("bugreport.internalOnlyNote")}
          </p>
        </div>
      )}

      <div className="bg-card border-border w-full rounded-xl border p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
            <div className="space-y-2">
              <Label htmlFor="category">{t("bugreport.category")}</Label>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v as CategoryValue)}
              >
                <SelectTrigger id="category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {t(c.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="subject">{t("bugreport.bugTitle")}</Label>
              <Input
                id="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={t("bugreport.bugTitlePlaceholder")}
                maxLength={200}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bug-desc">{t("bugreport.description")}</Label>
            <Textarea
              id="bug-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              minLength={10}
              maxLength={5000}
              rows={8}
            />
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

          <div className="flex items-center justify-end pt-2">
            <Button
              type="submit"
              disabled={loading}
              aria-busy={loading || undefined}
            >
              {/*
                v1.4.33 IW9 — swap the icon on loading (Loader2 takes
                the same 16x16 slot as the Bug icon) so the button
                width is stable across the disabled flip. The previous
                `{loading && <Loader2/>}<Bug/>` rendered both icons
                during the in-flight request and grew the button by
                ~24 px — the CLS regression flagged in the v1.4.33
                Lighthouse punch list (0.186 on
                `div.space-y-2 > Button > Loader-Circle`).
              */}
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Bug className="mr-2 h-4 w-4" />
              )}
              {t("bugreport.submit")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
