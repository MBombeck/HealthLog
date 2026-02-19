"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { startRegistration } from "@simplewebauthn/browser";
import { Heart, KeyRound, Loader2 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function RegisterPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
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
      // Step 1: Register user
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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

      // Step 2: Start passkey registration
      const { options, challengeId } = json.data.passkey;

      try {
        const credential = await startRegistration({ optionsJSON: options });

        // Step 3: Verify passkey
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
        // User cancelled passkey or not supported — that's okay, they're still registered
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
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="bg-card border-border w-full max-w-sm rounded-xl border p-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-full">
            <Heart className="text-primary h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Konto erstellen</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {step === "form"
                ? "Erstelle dein HealthLog Konto"
                : "Registriere deinen Passkey..."}
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
              <Label htmlFor="username">Benutzername</Label>
              <Input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="max_mustermann"
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
                  (optional)
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

            <p className="text-muted-foreground text-center text-sm">
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
