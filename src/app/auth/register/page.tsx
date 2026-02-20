"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { startRegistration } from "@simplewebauthn/browser";
import { KeyRound, Loader2 } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordStrength } from "@/components/ui/password-strength";

export default function RegisterPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"form" | "passkey">("form");

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          username,
          password: password || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error);
        setLoading(false);
        return;
      }

      setStep("passkey");

      const { options, challengeId } = json.data.passkey;

      try {
        const credential = await startRegistration({ optionsJSON: options });

        const verifyRes = await fetch("/api/auth/passkey/register-verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ challengeId, credential }),
        });

        if (!verifyRes.ok) {
          const verifyJson = await verifyRes.json();
          setError(verifyJson.error || "Passkey-Registrierung fehlgeschlagen");
          setLoading(false);
          return;
        }
      } catch {
        console.log("Passkey registration skipped");
      }

      await queryClient.invalidateQueries({ queryKey: ["auth"] });
      router.push("/");
    } catch {
      setError("Registrierung fehlgeschlagen");
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
            <h1 className="text-xl font-bold tracking-tight">
              Konto erstellen
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {step === "form"
                ? "Neues Konto erstellen"
                : "Passkey einrichten..."}
            </p>
          </div>
        </div>

        {step === "passkey" && loading && (
          <div className="mt-8 flex flex-col items-center gap-3">
            <Loader2 className="text-primary h-8 w-8 animate-spin" />
            <p className="text-muted-foreground text-sm">
              Folge der Anweisung deines Browsers...
            </p>
          </div>
        )}

        {step === "form" && (
          <form onSubmit={handleRegister} className="mt-8 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">E-Mail-Adresse</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@beispiel.de"
                required
                autoComplete="email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="username">Benutzername</Label>
              <Input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="user"
                required
                autoComplete="username"
                minLength={3}
                maxLength={30}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">
                Passwort{" "}
                <span className="text-muted-foreground font-normal">
                  (optional, Fallback)
                </span>
              </Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min. 12 Zeichen"
                autoComplete="new-password"
              />
              <PasswordStrength password={password} />
              <p className="text-muted-foreground text-xs">
                Passkeys sind die primäre Anmeldemethode. Passwort ist ein
                Fallback.
              </p>
            </div>

            {error && (
              <div className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="mr-2 h-4 w-4" />
              )}
              Registrieren
            </Button>

            <p className="text-muted-foreground text-center text-xs">
              Bereits ein Konto?{" "}
              <Link href="/auth/login" className="text-primary hover:underline">
                Anmelden
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
