"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  KeyRound,
  Loader2,
  MessageCircle,
  Save,
  Send,
  Shield,
  Key,
  Trash2,
  Link2,
  Unlink,
  RefreshCw,
  Download,
  ScrollText,
  Sparkles,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";
import { formatDate, formatDateTime } from "@/lib/format";

export default function SettingsPage() {
  const { user, isLoading, isAuthenticated, refetch } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [heightCm, setHeightCm] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [gender, setGender] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [passkeyMsg, setPasskeyMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    if (user) {
      setHeightCm(user.heightCm?.toString() ?? "");
      setDateOfBirth(
        user.dateOfBirth
          ? new Date(user.dateOfBirth).toISOString().slice(0, 10)
          : "",
      );
      setGender(user.gender ?? "");
    }
  }, [user]);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(null);

    const res = await fetch("/api/auth/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        heightCm: heightCm ? parseFloat(heightCm) : null,
        dateOfBirth: dateOfBirth || null,
        gender: gender || null,
      }),
    });

    if (res.ok) {
      setSaveMsg("Profil gespeichert");
      await refetch();
    } else {
      const json = await res.json();
      setSaveMsg(json.error || "Fehler beim Speichern");
    }
    setSaving(false);
  }

  async function handleAddPasskey() {
    setPasskeyLoading(true);
    setPasskeyMsg(null);

    try {
      const optRes = await fetch("/api/auth/passkey/register-options", {
        method: "POST",
      });

      if (!optRes.ok) {
        setPasskeyMsg("Konnte Passkey-Optionen nicht laden");
        setPasskeyLoading(false);
        return;
      }

      const optJson = await optRes.json();
      const { options, challengeId } = optJson.data;

      const credential = await startRegistration({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/passkey/register-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, credential }),
      });

      if (verifyRes.ok) {
        setPasskeyMsg("Passkey erfolgreich hinzugefügt!");
        queryClient.invalidateQueries({ queryKey: ["passkeys"] });
      } else {
        const verifyJson = await verifyRes.json();
        setPasskeyMsg(verifyJson.error || "Fehler bei Passkey-Registrierung");
      }
    } catch {
      setPasskeyMsg("Passkey-Registrierung abgebrochen");
    } finally {
      setPasskeyLoading(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!user) return null;

  const tocItems = [
    { id: "profil", label: "Profil" },
    { id: "sicherheit", label: "Sicherheit" },
    { id: "telegram", label: "Telegram" },
    { id: "insights", label: "KI-Insights" },
    { id: "withings", label: "Withings" },
    { id: "export", label: "Export" },
    { id: "daten", label: "Daten löschen" },
    { id: "protokoll", label: "Protokoll" },
  ];

  return (
    <div className="flex gap-8">
      {/* Sidebar TOC — desktop only */}
      <nav className="sticky top-20 hidden h-fit w-40 shrink-0 md:block">
        <h2 className="text-muted-foreground mb-3 text-xs font-medium tracking-wider uppercase">
          Einstellungen
        </h2>
        <ul className="space-y-1">
          {tocItems.map((item) => (
            <li key={item.id}>
              <button
                onClick={() =>
                  document
                    .getElementById(item.id)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
                className="text-foreground/80 hover:text-primary w-full text-left text-sm transition-colors"
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Main content */}
      <div className="min-w-0 flex-1 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Einstellungen</h1>
          <p className="text-muted-foreground text-sm">
            Profil, Sicherheit & Verbindungen
          </p>
        </div>

        {/* Profile Section */}
        <div
          id="profil"
          className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
        >
          <h2 className="mb-4 font-semibold">Profil</h2>
          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="username">Benutzername</Label>
                <Input id="username" value={user.username} disabled />
              </div>
              <div className="space-y-2">
                <Label htmlFor="height">Körpergröße (cm)</Label>
                <Input
                  id="height"
                  type="number"
                  value={heightCm}
                  onChange={(e) => setHeightCm(e.target.value)}
                  placeholder="175"
                  min={50}
                  max={300}
                  step={0.1}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="gender">Geschlecht</Label>
                <select
                  id="gender"
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
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="dob">Geburtsdatum</Label>
                <Input
                  id="dob"
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

            {saveMsg && (
              <div
                className={`rounded-lg p-3 text-sm ${
                  saveMsg.includes("gespeichert")
                    ? "bg-dracula-green/10 text-dracula-green"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                {saveMsg}
              </div>
            )}

            <Button type="submit" disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Speichern
            </Button>
          </form>
        </div>

        {/* Security Section */}
        <div
          id="sicherheit"
          className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
        >
          <div className="flex items-center gap-2">
            <Shield className="text-primary h-5 w-5" />
            <h2 className="font-semibold">Sicherheit</h2>
          </div>

          <div className="mt-4 space-y-4">
            {/* Passkey List */}
            <PasskeyListSection isAuthenticated={isAuthenticated} />

            {/* Add Passkey */}
            <div>
              <Button
                variant="outline"
                onClick={handleAddPasskey}
                disabled={passkeyLoading}
              >
                {passkeyLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <KeyRound className="mr-2 h-4 w-4" />
                )}
                Passkey hinzufügen
              </Button>
              {passkeyMsg && (
                <p
                  className={`mt-2 text-sm ${
                    passkeyMsg.includes("erfolgreich")
                      ? "text-dracula-green"
                      : "text-destructive"
                  }`}
                >
                  {passkeyMsg}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Telegram Section */}
        <TelegramSection id="telegram" isAuthenticated={isAuthenticated} />

        {/* OpenAI Insights Section */}
        <InsightsSettingsSection
          id="insights"
          isAuthenticated={isAuthenticated}
        />

        {/* Withings Section */}
        <WithingsSection id="withings" isAuthenticated={isAuthenticated} />

        {/* Export Section */}
        <ExportSection id="export" />

        {/* Data Reset Section */}
        <DataResetSection id="daten" />

        {/* Audit Log Section */}
        <AuditLogSection id="protokoll" isAuthenticated={isAuthenticated} />
      </div>
    </div>
  );
}

/* ─────────────────────── Passkey List ─────────────────────── */

interface PasskeyInfo {
  id: string;
  name: string;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
  createdAt: string;
}

function PasskeyListSection({ isAuthenticated }: { isAuthenticated: boolean }) {
  const queryClient = useQueryClient();
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

  const { data: passkeys } = useQuery({
    queryKey: ["passkeys"],
    queryFn: async () => {
      const res = await fetch("/api/auth/passkeys");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as PasskeyInfo[];
    },
    enabled: isAuthenticated,
  });

  const deletePasskey = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/auth/passkeys/${id}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Fehler");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["passkeys"] });
      setDeleteMsg(null);
    },
    onError: (err: Error) => {
      setDeleteMsg(err.message);
    },
  });

  const DEVICE_TYPE_LABELS: Record<string, string> = {
    singleDevice: "Einzelgerät",
    multiDevice: "Multi-Gerät",
  };

  if (!passkeys || passkeys.length === 0) {
    return (
      <div>
        <h3 className="text-sm font-medium">Passkeys</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Keine Passkeys registriert.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-medium">Registrierte Passkeys</h3>
      <p className="text-muted-foreground mt-1 text-xs">
        Passkeys ermöglichen sicheres Anmelden ohne Passwort.
      </p>
      <div className="mt-3 space-y-2">
        {passkeys.map((pk) => (
          <div
            key={pk.id}
            className="bg-muted/50 flex items-center justify-between rounded-lg p-3"
          >
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{pk.name}</p>
              <p className="text-muted-foreground text-xs">
                {DEVICE_TYPE_LABELS[pk.credentialDeviceType] ??
                  pk.credentialDeviceType}{" "}
                {pk.credentialBackedUp && "(gesichert)"} &middot;{" "}
                {formatDate(pk.createdAt)}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="text-destructive h-8 w-8"
              onClick={() => {
                if (confirm("Passkey wirklich löschen?")) {
                  deletePasskey.mutate(pk.id);
                }
              }}
              disabled={deletePasskey.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
      {deleteMsg && (
        <div className="text-destructive mt-2 flex items-center gap-2 text-sm">
          <AlertTriangle className="h-4 w-4" />
          {deleteMsg}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── Withings Integration ─────────────────────── */

function WithingsSection({
  id,
  isAuthenticated,
}: {
  id: string;
  isAuthenticated: boolean;
}) {
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsMsg, setCredsMsg] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["withings", "status"],
    queryFn: async () => {
      const res = await fetch("/api/withings/status");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as {
        connected: boolean;
        configured: boolean;
        lastSyncedAt?: string | null;
        connectedAt?: string;
        tokenExpired?: boolean;
      };
    },
    enabled: isAuthenticated,
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/withings/disconnect", { method: "POST" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["withings"] });
    },
  });

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/withings/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullSync }),
      });
      const json = await res.json();
      if (res.ok) {
        setSyncMsg(
          fullSync
            ? `${json.data.imported} Messwerte vollständig synchronisiert`
            : `${json.data.imported} Messwerte synchronisiert`,
        );
        queryClient.invalidateQueries({ queryKey: ["measurements"] });
      } else {
        setSyncMsg(json.error || "Sync fehlgeschlagen");
      }
    } catch {
      setSyncMsg("Sync fehlgeschlagen");
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    setCredsSaving(true);
    setCredsMsg(null);

    try {
      const res = await fetch("/api/withings/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });

      if (res.ok) {
        setCredsMsg("Zugangsdaten gespeichert");
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: ["withings"] });
      } else {
        try {
          const json = await res.json();
          setCredsMsg(json.error || "Fehler beim Speichern");
        } catch {
          setCredsMsg("Fehler beim Speichern (Server-Fehler)");
        }
      }
    } catch {
      setCredsMsg("Netzwerkfehler beim Speichern");
    }
    setCredsSaving(false);
  }

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <Link2 className="text-primary h-5 w-5" />
        <h2 className="font-semibold">Withings</h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        Verbinde deine Withings-Waage und Blutdruckmessgeräte.
      </p>

      <div className="mt-4 space-y-4">
        {/* Credentials section */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">API-Zugangsdaten</h3>
          <form onSubmit={handleSaveCredentials} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="w-clientid">Client-ID</Label>
                <Input
                  id="w-clientid"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    status?.configured
                      ? "Gespeichert — neue eingeben zum Ersetzen"
                      : "Client-ID"
                  }
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="w-secret">Client-Secret</Label>
                <Input
                  id="w-secret"
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    status?.configured
                      ? "Gespeichert — neues eingeben zum Ersetzen"
                      : "Client-Secret"
                  }
                  maxLength={200}
                />
              </div>
            </div>
            {credsMsg && (
              <p
                className={`text-sm ${credsMsg.includes("gespeichert") ? "text-dracula-green" : "text-destructive"}`}
              >
                {credsMsg}
              </p>
            )}
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={credsSaving || !clientId.trim() || !clientSecret.trim()}
            >
              {credsSaving ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1 h-3.5 w-3.5" />
              )}
              Zugangsdaten speichern
            </Button>
          </form>
        </div>

        {/* Connection status */}
        {status?.connected ? (
          <>
            <div className="bg-dracula-green/10 text-dracula-green rounded-lg p-3 text-sm">
              Verbunden
              {status.lastSyncedAt && (
                <span className="text-muted-foreground ml-2 text-xs">
                  · Letzte Sync: {formatDateTime(status.lastSyncedAt)}
                </span>
              )}
              {status.tokenExpired && (
                <Badge variant="destructive" className="ml-2 text-xs">
                  Token abgelaufen
                </Badge>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSync(false)}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                Jetzt synchronisieren
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (
                    confirm(
                      "Alle verfügbaren Withings-Daten vollständig synchronisieren? Das kann je nach Historie etwas dauern.",
                    )
                  ) {
                    void handleSync(true);
                  }
                }}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                Alle Daten synchronisieren
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive"
                onClick={() => {
                  if (confirm("Withings-Verbindung wirklich trennen?")) {
                    disconnect.mutate();
                  }
                }}
              >
                <Unlink className="mr-1 h-3.5 w-3.5" />
                Trennen
              </Button>
            </div>
            {syncMsg && (
              <p
                className={`text-sm ${syncMsg.includes("synchronisiert") ? "text-dracula-green" : "text-destructive"}`}
              >
                {syncMsg}
              </p>
            )}
          </>
        ) : status?.configured ? (
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/api/withings/connect";
            }}
          >
            <Link2 className="mr-2 h-4 w-4" />
            Mit Withings verbinden
          </Button>
        ) : (
          <div className="bg-muted/50 text-muted-foreground rounded-lg p-3 text-sm">
            Bitte zuerst die API-Zugangsdaten oben eingeben, um Withings zu
            verbinden.
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────── Export Section ─────────────────────── */

function ExportSection({ id }: { id: string }) {
  const [exporting, setExporting] = useState(false);

  async function handleExport(format: "csv" | "json") {
    setExporting(true);
    try {
      const res = await fetch(`/api/export?format=${format}&type=all`);
      if (!res.ok) return;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `healthlog-export-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <Download className="text-primary h-5 w-5" />
        <h2 className="font-semibold">Daten-Export</h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        Exportiere alle deine Gesundheitsdaten.
      </p>
      <div className="mt-4 flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleExport("json")}
          disabled={exporting}
        >
          {exporting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          JSON-Export
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleExport("csv")}
          disabled={exporting}
        >
          {exporting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          CSV-Export
        </Button>
      </div>
    </div>
  );
}

/* ─────────────────────── Data Reset Section ─────────────────────── */

function DataResetSection({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function handleDeleteAllData() {
    const ok = confirm(
      "Wirklich alle deine Daten löschen? Dieser Vorgang kann nicht rückgängig gemacht werden.",
    );
    if (!ok) return;

    setDeleting(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/data", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMsg(json.error || "Löschen fehlgeschlagen");
        return;
      }

      await queryClient.invalidateQueries();
      setMsg("Alle persönlichen Daten wurden gelöscht");
    } catch {
      setMsg("Löschen fehlgeschlagen");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-5 w-5 text-orange-400" />
        <h2 className="font-semibold">Alle Daten löschen</h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        Löscht alle deine Gesundheitsdaten und Integrationen. Dein Benutzerkonto
        bleibt erhalten.
      </p>

      <div className="mt-4">
        <Button
          variant="destructive"
          size="sm"
          onClick={handleDeleteAllData}
          disabled={deleting}
        >
          {deleting ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="mr-1 h-3.5 w-3.5" />
          )}
          Alle Daten löschen
        </Button>
      </div>

      {msg && (
        <p
          className={`mt-3 text-sm ${msg.includes("gelöscht") ? "text-dracula-green" : "text-destructive"}`}
        >
          {msg}
        </p>
      )}
    </div>
  );
}

/* ─────────────────────── Audit Log Section ─────────────────────── */

interface AuditEntry {
  id: string;
  action: string;
  ipAddress: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  "auth.register": "Registrierung",
  "auth.login": "Anmeldung",
  "auth.login.passkey": "Passkey-Anmeldung",
  "auth.logout": "Abmeldung",
  "auth.passkey.register": "Passkey hinzugefügt",
  "auth.passkey.delete": "Passkey gelöscht",
  "measurement.create": "Messwert erstellt",
  "measurement.update": "Messwert aktualisiert",
  "measurement.delete": "Messwert gelöscht",
  "medication.create": "Medikament erstellt",
  "medication.update": "Medikament aktualisiert",
  "medication.delete": "Medikament gelöscht",
  "medication.intake": "Einnahme erfasst",
  "medication.ingest.external": "Externe Einnahme",
  "withings.connect": "Withings verbunden",
  "withings.disconnect": "Withings getrennt",
  "export.download": "Export heruntergeladen",
  "insights.generate": "KI-Insight generiert",
  "admin.user.update": "Admin: Benutzer aktualisiert",
  "admin.user.reset-password": "Admin: Passwort zurückgesetzt",
  "admin.settings.update": "Admin: Einstellungen geändert",
};

const ACTION_CATEGORIES: Record<string, { label: string; color: string }> = {
  auth: { label: "Auth", color: "bg-blue-500/15 text-blue-400" },
  measurement: { label: "Daten", color: "bg-emerald-500/15 text-emerald-400" },
  medication: { label: "Daten", color: "bg-emerald-500/15 text-emerald-400" },
  withings: {
    label: "Integration",
    color: "bg-violet-500/15 text-violet-400",
  },
  export: {
    label: "Integration",
    color: "bg-violet-500/15 text-violet-400",
  },
  insights: { label: "KI", color: "bg-amber-500/15 text-amber-400" },
  admin: { label: "Admin", color: "bg-red-500/15 text-red-400" },
  profile: { label: "Daten", color: "bg-emerald-500/15 text-emerald-400" },
};

function getActionCategory(action: string) {
  const prefix = action.split(".")[0];
  return (
    ACTION_CATEGORIES[prefix] ?? {
      label: "Sonstig",
      color: "bg-muted text-muted-foreground",
    }
  );
}

function AuditLogSection({
  id,
  isAuthenticated,
}: {
  id: string;
  isAuthenticated: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const { data } = useQuery({
    queryKey: ["audit-log"],
    queryFn: async () => {
      const res = await fetch("/api/audit-log?limit=50");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as {
        entries: AuditEntry[];
        meta: { total: number };
      };
    },
    enabled: isAuthenticated && expanded,
  });

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScrollText className="text-primary h-5 w-5" />
          <h2 className="font-semibold">Aktivitätsprotokoll</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-controls="audit-log-content"
        >
          {expanded ? "Einklappen" : "Ausklappen"}
          <ChevronDown
            className={`ml-1 h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </Button>
      </div>

      {expanded ? (
        <div id="audit-log-content" className="mt-4">
          {!data ? (
            <div className="flex justify-center py-4">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : data.entries.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Keine Aktivitäten vorhanden.
            </p>
          ) : (
            <>
              {/* Table header */}
              <div className="text-muted-foreground mb-1 hidden grid-cols-[1fr_auto_auto_auto] gap-3 px-3 text-xs font-medium sm:grid">
                <span>Aktion</span>
                <span className="w-20 text-center">Kategorie</span>
                <span className="w-28 text-right">IP</span>
                <span className="w-36 text-right">Zeitpunkt</span>
              </div>
              <div className="divide-border divide-y">
                {data.entries.map((entry, i) => {
                  const cat = getActionCategory(entry.action);
                  return (
                    <div
                      key={entry.id}
                      className={`grid grid-cols-1 gap-1 px-3 py-2 text-sm sm:grid-cols-[1fr_auto_auto_auto] sm:items-center sm:gap-3 ${
                        i % 2 === 0 ? "bg-muted/30" : ""
                      }`}
                    >
                      <span className="truncate">
                        {ACTION_LABELS[entry.action] ?? entry.action}
                      </span>
                      <span className="flex sm:w-20 sm:justify-center">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cat.color}`}
                        >
                          {cat.label}
                        </span>
                      </span>
                      <span className="text-muted-foreground w-28 text-right font-mono text-xs">
                        {entry.ipAddress ?? "—"}
                      </span>
                      <span className="text-muted-foreground w-36 text-right text-xs whitespace-nowrap">
                        {formatDateTime(entry.createdAt)}
                      </span>
                    </div>
                  );
                })}
              </div>
              {data.meta.total > 50 && (
                <p className="text-muted-foreground mt-3 text-center text-xs">
                  Zeigt die letzten 50 von {data.meta.total} Einträgen
                </p>
              )}
            </>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground mt-3 text-sm">
          Protokoll ausgeblendet.
        </p>
      )}
    </div>
  );
}

/* ─────────────────────── Telegram Notifications ─────────────────────── */

function TelegramSection({
  id,
  isAuthenticated,
}: {
  id: string;
  isAuthenticated: boolean;
}) {
  const queryClient = useQueryClient();
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const { data: settings } = useQuery({
    queryKey: ["telegram", "settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings/telegram");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as {
        enabled: boolean;
        hasBotToken: boolean;
        chatId: string | null;
      };
    },
    enabled: isAuthenticated,
  });

  const [enabled, setEnabled] = useState(false);
  const [initialized, setInitialized] = useState(false);
  if (settings && !initialized) {
    setEnabled(settings.enabled);
    if (settings.chatId) setChatId(settings.chatId);
    setInitialized(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);

    const body: Record<string, unknown> = { enabled };
    if (botToken.trim()) body.botToken = botToken.trim();
    if (chatId !== (settings?.chatId ?? "")) body.chatId = chatId;

    const res = await fetch("/api/settings/telegram", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      setMsg("Telegram-Einstellungen gespeichert");
      setBotToken("");
      queryClient.invalidateQueries({ queryKey: ["telegram"] });
    } else {
      const json = await res.json();
      setMsg(json.error || "Fehler beim Speichern");
    }
    setSaving(false);
  }

  async function handleTest() {
    setTesting(true);
    setMsg(null);

    const res = await fetch("/api/settings/telegram/test", { method: "POST" });
    if (res.ok) {
      setMsg("Test-Nachricht gesendet!");
    } else {
      const json = await res.json();
      setMsg(json.error || "Test fehlgeschlagen");
    }
    setTesting(false);
  }

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <MessageCircle className="text-primary h-5 w-5" />
        <h2 className="font-semibold">Telegram-Benachrichtigungen</h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        Erhalte Erinnerungen bei vergessenen Medikamenten-Einnahmen per
        Telegram.
      </p>

      <div className="mt-4 space-y-4">
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="tg-token">Bot-Token</Label>
              <Input
                id="tg-token"
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={
                  settings?.hasBotToken
                    ? "Gespeichert — neuen eingeben zum Ersetzen"
                    : "123456:ABC-DEF..."
                }
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tg-chatid">Chat-ID</Label>
              <Input
                id="tg-chatid"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="123456789"
                maxLength={50}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Switch
              id="tg-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
            <Label htmlFor="tg-enabled" className="cursor-pointer">
              Benachrichtigungen aktivieren
            </Label>
          </div>

          <div className="bg-muted/50 text-muted-foreground rounded-lg p-3 text-xs">
            <p>
              1. Erstelle einen Bot über <strong>@BotFather</strong> in Telegram
              und kopiere den Token.
            </p>
            <p>
              2. Sende <code>/start</code> an deinen Bot, um den Chat zu
              aktivieren.
            </p>
            <p>
              3. Finde deine Chat-ID über <strong>@userinfobot</strong> oder die
              Bot-API.
            </p>
          </div>

          {msg && (
            <p
              className={`text-sm ${
                msg.includes("gespeichert") || msg.includes("gesendet")
                  ? "text-dracula-green"
                  : "text-destructive"
              }`}
            >
              {msg}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Speichern
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={testing || !settings?.hasBotToken}
              onClick={handleTest}
            >
              {testing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              Test-Nachricht
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─────────────────────── OpenAI Insights Settings ─────────────────────── */

function InsightsSettingsSection({
  id,
  isAuthenticated,
}: {
  id: string;
  isAuthenticated: boolean;
}) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const { data: settings } = useQuery({
    queryKey: ["insights", "settings"],
    queryFn: async () => {
      const res = await fetch("/api/insights/settings");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as {
        hasKey: boolean;
        privacyMode: string;
        lastInsightAt: string | null;
      };
    },
    enabled: isAuthenticated,
  });

  const updateSettings = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch("/api/insights/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
  });

  async function handleSaveKey(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      await updateSettings.mutateAsync({ apiKey: apiKey.trim() });
      setMsg(apiKey.trim() ? "API-Key gespeichert" : "API-Key entfernt");
      setApiKey("");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Fehler beim Speichern");
    } finally {
      setSaving(false);
    }
  }

  async function togglePrivacyMode() {
    const newMode = settings?.privacyMode === "raw" ? "aggregated" : "raw";
    await updateSettings.mutateAsync({ privacyMode: newMode });
  }

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="text-dracula-purple h-5 w-5" />
        <h2 className="font-semibold">KI-Insights (OpenAI)</h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        Optional: KI-basierte Analyse deiner Gesundheitsdaten. Dein API-Key wird
        verschlüsselt gespeichert und nie an den Browser übertragen.
      </p>

      <div className="mt-4 space-y-4">
        {/* API Key */}
        <form onSubmit={handleSaveKey} className="flex gap-2">
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              settings?.hasKey
                ? "Key hinterlegt — neuen eingeben zum Ersetzen"
                : "sk-..."
            }
            className="flex-1"
          />
          <Button variant="outline" type="submit" disabled={saving}>
            {saving ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Key className="mr-1 h-4 w-4" />
            )}
            {settings?.hasKey ? "Ersetzen" : "Speichern"}
          </Button>
          {settings?.hasKey && (
            <Button
              variant="ghost"
              type="button"
              className="text-destructive"
              onClick={async () => {
                await updateSettings.mutateAsync({ apiKey: "" });
                setMsg("API-Key entfernt");
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </form>

        {msg && (
          <p
            className={`text-sm ${msg.includes("gespeichert") || msg.includes("entfernt") ? "text-dracula-green" : "text-destructive"}`}
          >
            {msg}
          </p>
        )}

        {/* Privacy Mode */}
        {settings?.hasKey && (
          <div className="bg-muted/50 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Rohdaten mitsenden</p>
                <p className="text-muted-foreground text-xs">
                  {settings.privacyMode === "raw"
                    ? "Anonymisierte Rohdaten der letzten 30 Tage werden an OpenAI gesendet."
                    : "Nur aggregierte Werte (Durchschnitte, Trends) werden gesendet. Keine exakten Zeitstempel oder Einzelwerte."}
                </p>
              </div>
              <Switch
                checked={settings.privacyMode === "raw"}
                onCheckedChange={togglePrivacyMode}
              />
            </div>
            {settings.privacyMode === "raw" && (
              <div className="mt-2 rounded-lg bg-orange-500/10 p-2 text-xs text-orange-400">
                Hinweis: Im Rohdaten-Modus werden anonymisierte Einzelmesswerte
                der letzten 30 Tage an die OpenAI-API übertragen.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
