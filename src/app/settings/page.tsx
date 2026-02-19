"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  KeyRound,
  Loader2,
  Save,
  Shield,
  Key,
  Copy,
  Trash2,
  Link2,
  Unlink,
  RefreshCw,
  Download,
  ScrollText,
  Sparkles,
} from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";

export default function SettingsPage() {
  const { user, isLoading, isAuthenticated, refetch } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [heightCm, setHeightCm] = useState("");
  const [bpSysLow, setBpSysLow] = useState("");
  const [bpSysHigh, setBpSysHigh] = useState("");
  const [bpDiaLow, setBpDiaLow] = useState("");
  const [bpDiaHigh, setBpDiaHigh] = useState("");
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
      setBpSysLow(user.bpSysTargetLow?.toString() ?? "");
      setBpSysHigh(user.bpSysTargetHigh?.toString() ?? "");
      setBpDiaLow(user.bpDiaTargetLow?.toString() ?? "");
      setBpDiaHigh(user.bpDiaTargetHigh?.toString() ?? "");
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
        bpSysTargetLow: bpSysLow ? parseInt(bpSysLow) : null,
        bpSysTargetHigh: bpSysHigh ? parseInt(bpSysHigh) : null,
        bpDiaTargetLow: bpDiaLow ? parseInt(bpDiaLow) : null,
        bpDiaTargetHigh: bpDiaHigh ? parseInt(bpDiaHigh) : null,
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Einstellungen</h1>
        <p className="text-muted-foreground text-sm">
          Profil, Sicherheit & Verbindungen
        </p>
      </div>

      {/* Profile Section */}
      <div className="bg-card border-border rounded-xl border p-6">
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

          <Separator />
          <h3 className="text-sm font-medium">
            Blutdruck-Zielbereiche{" "}
            <span className="text-muted-foreground font-normal">
              (optional)
            </span>
          </h3>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="bpSysLow">Systolisch min (mmHg)</Label>
              <Input
                id="bpSysLow"
                type="number"
                value={bpSysLow}
                onChange={(e) => setBpSysLow(e.target.value)}
                placeholder="110"
                min={60}
                max={200}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bpSysHigh">Systolisch max (mmHg)</Label>
              <Input
                id="bpSysHigh"
                type="number"
                value={bpSysHigh}
                onChange={(e) => setBpSysHigh(e.target.value)}
                placeholder="140"
                min={60}
                max={250}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bpDiaLow">Diastolisch min (mmHg)</Label>
              <Input
                id="bpDiaLow"
                type="number"
                value={bpDiaLow}
                onChange={(e) => setBpDiaLow(e.target.value)}
                placeholder="70"
                min={30}
                max={150}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bpDiaHigh">Diastolisch max (mmHg)</Label>
              <Input
                id="bpDiaHigh"
                type="number"
                value={bpDiaHigh}
                onChange={(e) => setBpDiaHigh(e.target.value)}
                placeholder="90"
                min={30}
                max={150}
              />
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
      <div className="bg-card border-border rounded-xl border p-6">
        <div className="flex items-center gap-2">
          <Shield className="text-primary h-5 w-5" />
          <h2 className="font-semibold">Sicherheit</h2>
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <h3 className="text-sm font-medium">Passkeys</h3>
            <p className="text-muted-foreground mt-1 text-xs">
              Passkeys ermöglichen sicheres Anmelden ohne Passwort.
            </p>
            <Button
              variant="outline"
              className="mt-2"
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

      {/* OpenAI Insights Section */}
      <InsightsSettingsSection isAuthenticated={isAuthenticated} />

      {/* API Tokens Section */}
      <ApiTokenSection
        queryClient={queryClient}
        isAuthenticated={isAuthenticated}
      />

      {/* Withings Section */}
      <WithingsSection isAuthenticated={isAuthenticated} />

      {/* Export Section */}
      <ExportSection />

      {/* Audit Log Section */}
      <AuditLogSection isAuthenticated={isAuthenticated} />
    </div>
  );
}

/* ─────────────────────── API Token Management ─────────────────────── */

interface ApiToken {
  id: string;
  name: string;
  permissions: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revoked: boolean;
}

function ApiTokenSection({
  queryClient,
  isAuthenticated,
}: {
  queryClient: ReturnType<typeof useQueryClient>;
  isAuthenticated: boolean;
}) {
  const [tokenName, setTokenName] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  const { data: tokens } = useQuery({
    queryKey: ["api-tokens"],
    queryFn: async () => {
      const res = await fetch("/api/tokens");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as ApiToken[];
    },
    enabled: isAuthenticated,
  });

  const createToken = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as { token: string; name: string };
    },
    onSuccess: (data) => {
      setNewToken(data.token);
      setTokenName("");
      queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });

  const revokeToken = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/tokens/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });

  async function copyToken() {
    if (!newToken) return;
    await navigator.clipboard.writeText(newToken);
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  }

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <Key className="text-primary h-5 w-5" />
        <h2 className="font-semibold">API-Tokens</h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        Tokens für die externe Medikamenten-Einnahme-API.
      </p>

      <div className="mt-4 space-y-4">
        {/* Create token */}
        <div className="flex gap-2">
          <Input
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            placeholder="Token-Name (z.B. iPhone Shortcut)"
            maxLength={100}
            className="flex-1"
          />
          <Button
            variant="outline"
            disabled={!tokenName.trim() || createToken.isPending}
            onClick={() => createToken.mutate(tokenName.trim())}
          >
            {createToken.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Key className="mr-1 h-4 w-4" />
            )}
            Erstellen
          </Button>
        </div>

        {/* Show new token (only once) */}
        {newToken && (
          <div className="bg-dracula-green/10 rounded-lg p-3">
            <p className="text-dracula-green mb-2 text-sm font-medium">
              Token erstellt — jetzt kopieren, er wird nicht erneut angezeigt!
            </p>
            <div className="flex items-center gap-2">
              <code className="bg-background flex-1 rounded px-2 py-1 font-mono text-xs break-all">
                {newToken}
              </code>
              <Button variant="ghost" size="icon" onClick={copyToken}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            {tokenCopied && (
              <p className="text-dracula-green mt-1 text-xs">Kopiert!</p>
            )}
          </div>
        )}

        {/* Token list */}
        {tokens && tokens.length > 0 && (
          <div className="space-y-2">
            {tokens.map((t) => (
              <div
                key={t.id}
                className="bg-muted/50 flex items-center justify-between rounded-lg p-3"
              >
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">
                    {t.name}
                    {t.revoked && (
                      <Badge variant="destructive" className="ml-2 text-xs">
                        Widerrufen
                      </Badge>
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Erstellt:{" "}
                    {new Date(t.createdAt).toLocaleDateString("de-DE")}
                    {t.lastUsedAt &&
                      ` · Zuletzt: ${new Date(t.lastUsedAt).toLocaleDateString("de-DE")}`}
                  </p>
                </div>
                {!t.revoked && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive h-8 w-8"
                    onClick={() => {
                      if (confirm("Token wirklich widerrufen?")) {
                        revokeToken.mutate(t.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────── Withings Integration ─────────────────────── */

function WithingsSection({ isAuthenticated }: { isAuthenticated: boolean }) {
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["withings", "status"],
    queryFn: async () => {
      const res = await fetch("/api/withings/status");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as {
        connected: boolean;
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

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/withings/sync", { method: "POST" });
      const json = await res.json();
      if (res.ok) {
        setSyncMsg(`${json.data.imported} Messwerte synchronisiert`);
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

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <Link2 className="text-primary h-5 w-5" />
        <h2 className="font-semibold">Withings</h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        Verbinde deine Withings-Waage und Blutdruckmessgeräte.
      </p>

      <div className="mt-4 space-y-3">
        {status?.connected ? (
          <>
            <div className="bg-dracula-green/10 text-dracula-green rounded-lg p-3 text-sm">
              Verbunden
              {status.lastSyncedAt && (
                <span className="text-muted-foreground ml-2 text-xs">
                  · Letzte Sync:{" "}
                  {new Date(status.lastSyncedAt).toLocaleString("de-DE", {
                    timeZone: "Europe/Berlin",
                  })}
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
                onClick={handleSync}
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
        ) : (
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/api/withings/connect";
            }}
          >
            <Link2 className="mr-2 h-4 w-4" />
            Mit Withings verbinden
          </Button>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────── Export Section ─────────────────────── */

function ExportSection() {
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
    <div className="bg-card border-border rounded-xl border p-6">
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
};

function AuditLogSection({ isAuthenticated }: { isAuthenticated: boolean }) {
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
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScrollText className="text-primary h-5 w-5" />
          <h2 className="font-semibold">Aktivitätsprotokoll</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Ausblenden" : "Anzeigen"}
        </Button>
      </div>

      {expanded && data && (
        <div className="mt-4 space-y-2">
          {data.entries.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Keine Aktivitäten vorhanden.
            </p>
          ) : (
            data.entries.map((entry) => (
              <div
                key={entry.id}
                className="bg-muted/50 flex items-center justify-between rounded-lg px-3 py-2"
              >
                <div>
                  <p className="text-sm">
                    {ACTION_LABELS[entry.action] ?? entry.action}
                  </p>
                  {entry.ipAddress && (
                    <p className="text-muted-foreground text-xs">
                      IP: {entry.ipAddress}
                    </p>
                  )}
                </div>
                <span className="text-muted-foreground text-xs whitespace-nowrap">
                  {new Date(entry.createdAt).toLocaleString("de-DE", {
                    timeZone: "Europe/Berlin",
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))
          )}
          {data.meta.total > 50 && (
            <p className="text-muted-foreground text-center text-xs">
              Zeigt die letzten 50 von {data.meta.total} Einträgen
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── OpenAI Insights Settings ─────────────────────── */

function InsightsSettingsSection({
  isAuthenticated,
}: {
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
    <div className="bg-card border-border rounded-xl border p-6">
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
