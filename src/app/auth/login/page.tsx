"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { startAuthentication } from "@simplewebauthn/browser";
import { Heart, KeyRound, Lock, Loader2 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"passkey" | "password">("passkey");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handlePasskeyLogin() {
    setError(null);
    setLoading(true);

    try {
      // Get authentication options
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

      // Start browser passkey flow
      const credential = await startAuthentication({ optionsJSON: options });

      // Verify
      const verifyRes = await fetch("/api/auth/passkey/login-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, credential }),
      });

      const verifyJson = await verifyRes.json();
      if (!verifyRes.ok) {
        setError(verifyJson.error || "Anmeldung fehlgeschlagen");
        setLoading(false);
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ["auth"] });
      router.push("/");
    } catch {
      setError("Passkey-Anmeldung abgebrochen oder fehlgeschlagen");
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
        body: JSON.stringify({ username, password }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error);
        setLoading(false);
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ["auth"] });
      router.push("/");
    } catch {
      setError("Anmeldung fehlgeschlagen");
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
            <h1 className="text-xl font-bold">HealthLog</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Melde dich an, um fortzufahren
            </p>
          </div>
        </div>

        <div className="mt-8 space-y-4">
          {/* Passkey login */}
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
            Mit Passkey anmelden
          </Button>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-muted-foreground text-xs">oder</span>
            <Separator className="flex-1" />
          </div>

          {mode === "passkey" ? (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setMode("password")}
            >
              <Lock className="mr-2 h-4 w-4" />
              Mit Passwort anmelden
            </Button>
          ) : (
            <form onSubmit={handlePasswordLogin} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="username">Benutzername</Label>
                <Input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  autoComplete="username"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Passwort</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && mode === "password" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Lock className="mr-2 h-4 w-4" />
                )}
                Anmelden
              </Button>
              <button
                type="button"
                onClick={() => setMode("passkey")}
                className="text-muted-foreground hover:text-foreground w-full text-center text-xs"
              >
                Zurück zu Passkey
              </button>
            </form>
          )}

          {error && (
            <div className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm">
              {error}
            </div>
          )}

          <p className="text-muted-foreground text-center text-sm">
            Noch kein Konto?{" "}
            <Link
              href="/auth/register"
              className="text-primary hover:underline"
            >
              Registrieren
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
