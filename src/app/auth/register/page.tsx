"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, UserPlus } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordStrength } from "@/components/ui/password-strength";
import { useTranslations } from "@/lib/i18n/context";
import { detectBrowserTimezone } from "@/lib/tz/format";
import { queryKeys } from "@/lib/query-keys";

export default function RegisterPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { t } = useTranslations();
  // v1.4.27 MB3 — explicit error-region id wired to every required
  // input via `aria-describedby` so screen readers pair the validation
  // failure with the offending field instead of announcing it as a
  // standalone alert detached from the form.
  const errorId = useId();
  const errorDescriptor = error ? errorId : undefined;

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      // v1.4.25 W7 — ship the browser-detected timezone with the
      // signup payload. Server validates against the IANA list and
      // falls back to the admin server-default if the value is
      // bogus, so a tampered or proxied request can never poison
      // the user's stored zone.
      const timezone = detectBrowserTimezone();
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, username, password, timezone }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error);
        setLoading(false);
        return;
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.auth() });
      router.push("/");
    } catch {
      setError(t("auth.registerFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      {/* v1.4.27 MB7 / CF-61 — drop `p-8` to `p-6 sm:p-8` so the
          auth card breathes on Galaxy Fold / Pixel 5 without stealing
          half the visible viewport with padding. Tablet+ keeps the
          generous 32 px padding. */}
      <div className="border-border bg-card rounded-xl border p-6 shadow-lg shadow-black/20 sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-lg">
            <Logo className="text-primary" size={28} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              {t("auth.createAccount")}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {t("auth.newAccount")}
            </p>
          </div>
        </div>

        <form onSubmit={handleRegister} className="mt-8 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t("auth.email")}</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("auth.emailPlaceholder")}
              required
              autoComplete="email"
              enterKeyHint="next"
              autoCapitalize="none"
              spellCheck={false}
              aria-required="true"
              aria-invalid={!!error || undefined}
              aria-describedby={errorDescriptor}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="username">{t("auth.username")}</Label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="user"
              required
              autoComplete="username"
              enterKeyHint="next"
              autoCapitalize="none"
              spellCheck={false}
              aria-required="true"
              aria-invalid={!!error || undefined}
              aria-describedby={errorDescriptor}
              minLength={3}
              maxLength={30}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">{t("auth.password")}</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("auth.passwordMinLength")}
              required
              autoComplete="new-password"
              enterKeyHint="go"
              aria-required="true"
              aria-invalid={!!error || undefined}
              aria-describedby={errorDescriptor}
            />
            <PasswordStrength password={password} />
            <p className="text-muted-foreground text-xs">
              {t("auth.passkeySetupLater")}
            </p>
          </div>

          {error && (
            <div
              id={errorId}
              role="alert"
              aria-live="polite"
              className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
            >
              {error}
            </div>
          )}

          {/* v1.4.27 MB6 — lift the submit to the 44 px tap-target
              floor and the `lg` size so the primary action stays
              reachable on a narrow viewport without falling under the
              iOS keyboard's accessory bar. */}
          <Button
            type="submit"
            size="lg"
            className="min-h-11 w-full"
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <UserPlus className="mr-2 h-4 w-4" />
            )}
            {t("auth.register")}
          </Button>

          <p className="text-muted-foreground text-center text-xs">
            {t("auth.hasAccount")}{" "}
            <Link href="/auth/login" className="text-primary hover:underline">
              {t("auth.login")}
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
