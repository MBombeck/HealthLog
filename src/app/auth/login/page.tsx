"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Lock, Loader2 } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { describePasskeyError } from "@/lib/passkey-errors";
import { useTranslations } from "@/lib/i18n/context";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  const [mode, setMode] = useState<"passkey" | "password">("passkey");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { data: registrationEnabled } = useQuery({
    queryKey: ["auth", "registration-status"],
    queryFn: async () => {
      const res = await fetch("/api/auth/registration-status", {
        cache: "no-store",
      });
      if (!res.ok) return true;
      const json = await res.json();
      return Boolean(json.data?.registrationEnabled ?? true);
    },
    staleTime: 60 * 1000,
  });

  function getRedirectTarget(): string {
    const next = searchParams.get("next");
    if (!next) return "/";
    // Prevent open redirects: only allow local absolute paths.
    if (next.startsWith("/") && !next.startsWith("//")) {
      return next;
    }
    return "/";
  }

  async function handlePasskeyLogin() {
    setError(null);
    setLoading(true);

    try {
      const optRes = await fetch("/api/auth/passkey/login-options", {
        method: "POST",
      });
      const optJson = await optRes.json();
      if (!optRes.ok) {
        setError(optJson.error);
        setLoading(false);
        return;
      }

      const { options, challengeId } = optJson.data;
      const { startAuthentication } = await import(
        "@simplewebauthn/browser"
      );
      const credential = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/passkey/login-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, credential }),
      });

      const verifyJson = await verifyRes.json();
      if (!verifyRes.ok) {
        setError(verifyJson.error || t("auth.loginFailed"));
        setLoading(false);
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ["auth"] });
      router.push(getRedirectTarget());
    } catch (err) {
      const { key, params } = describePasskeyError(err);
      setError(t(key, params));
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error);
        setLoading(false);
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ["auth"] });
      router.push(getRedirectTarget());
    } catch {
      setError(t("auth.loginFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="border-border bg-card rounded-xl border p-8 shadow-lg shadow-black/20">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-lg">
            <Logo className="text-primary" size={28} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">HealthLog</h1>
          </div>
        </div>

        <div className="mt-8 space-y-4">
          <Button
            onClick={handlePasskeyLogin}
            className="w-full"
            disabled={loading}
          >
            {loading && mode === "passkey" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="mr-2 h-4 w-4" />
            )}
            {t("auth.loginWithPasskey")}
          </Button>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-muted-foreground text-xs">
              {t("common.or")}
            </span>
            <Separator className="flex-1" />
          </div>

          {mode === "passkey" ? (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setMode("password")}
            >
              <Lock className="mr-2 h-4 w-4" />
              {t("auth.loginWithPassword")}
            </Button>
          ) : (
            <form onSubmit={handlePasswordLogin} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="email">{t("auth.emailOrUsername")}</Label>
                <Input
                  id="email"
                  type="text"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="username"
                  placeholder={t("auth.emailOrUsernamePlaceholder")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t("auth.password")}</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  placeholder="********"
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && mode === "password" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Lock className="mr-2 h-4 w-4" />
                )}
                {t("auth.login")}
              </Button>
              <button
                type="button"
                onClick={() => setMode("passkey")}
                className="text-muted-foreground hover:text-foreground w-full text-center text-xs"
              >
                {t("auth.backToPasskey")}
              </button>
            </form>
          )}

          {error && (
            <div
              role="alert"
              className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
            >
              {error}
            </div>
          )}

          {registrationEnabled === true && (
            <p className="text-muted-foreground text-center text-xs">
              {t("auth.noAccount")}{" "}
              <Link
                href="/auth/register"
                className="text-primary hover:underline"
              >
                {t("auth.register")}
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
