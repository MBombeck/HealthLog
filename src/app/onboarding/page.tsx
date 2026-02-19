"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/ui/logo";
import { Loader2 } from "lucide-react";

export default function OnboardingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [heightCm, setHeightCm] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [gender, setGender] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleComplete(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    const body: Record<string, unknown> = {};
    if (heightCm) body.heightCm = parseFloat(heightCm);
    if (dateOfBirth) body.dateOfBirth = dateOfBirth;
    if (gender) body.gender = gender;

    await fetch("/api/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await queryClient.invalidateQueries({ queryKey: ["auth"] });
    router.replace("/");
  }

  async function handleSkip() {
    setSaving(true);
    await fetch("/api/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await queryClient.invalidateQueries({ queryKey: ["auth"] });
    router.replace("/");
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-8">
      <div className="text-center">
        <Logo className="text-primary mx-auto mb-4" size={48} />
        <h1 className="text-2xl font-bold tracking-tight">
          Willkommen bei HealthLog!
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Richte dein Profil ein, um loszulegen. Du kannst das auch später in
          den Einstellungen ändern.
        </p>
      </div>

      <form onSubmit={handleComplete} className="space-y-6">
        <div className="bg-card border-border space-y-4 rounded-xl border p-6">
          <h2 className="font-semibold">Profil</h2>
          <div className="space-y-2">
            <Label htmlFor="ob-height">Körpergröße (cm)</Label>
            <Input
              id="ob-height"
              type="number"
              value={heightCm}
              onChange={(e) => setHeightCm(e.target.value)}
              placeholder="175"
              min={50}
              max={300}
              step={0.1}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ob-gender">Geschlecht</Label>
            <select
              id="ob-gender"
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="border-input bg-background text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              <option value="">Keine Angabe</option>
              <option value="MALE">Männlich</option>
              <option value="FEMALE">Weiblich</option>
            </select>
            <p className="text-muted-foreground text-xs">
              Wird für geschlechtsspezifische Zielwerte verwendet.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ob-dob">Geburtsdatum</Label>
            <Input
              id="ob-dob"
              type="date"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
            />
            <p className="text-muted-foreground text-xs">
              Wird für die automatische Berechnung der Blutdruck-Zielwerte
              benötigt.
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <Button type="submit" className="flex-1" disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Einrichtung abschließen
          </Button>
        </div>

        <div className="text-center">
          <button
            type="button"
            onClick={handleSkip}
            disabled={saving}
            className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4 transition-colors"
          >
            Überspringen
          </button>
        </div>
      </form>
    </div>
  );
}
