"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { MedicationForm } from "@/components/medications/medication-form";
import { MedicationCard } from "@/components/medications/medication-card";
import { IntakeTimeline } from "@/components/medications/intake-timeline";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Pill, Upload, Terminal, Copy } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

interface Schedule {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
}

interface Medication {
  id: string;
  name: string;
  dose: string;
  category: "BLOOD_PRESSURE" | "VITAMIN" | "OTHER";
  active: boolean;
  schedules: Schedule[];
}

export default function MedicationsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMed, setEditingMed] = useState<Medication | null>(null);
  const [showEditTimeline, setShowEditTimeline] = useState(false);
  const [importMedId, setImportMedId] = useState<string | null>(null);
  const [apiMed, setApiMed] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const { data: medications, isLoading } = useQuery({
    queryKey: ["medications"],
    queryFn: async () => {
      const res = await fetch("/api/medications");
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data as Medication[];
    },
    enabled: isAuthenticated,
  });

  function openCreate() {
    setEditingMed(null);
    setShowEditTimeline(false);
    setDialogOpen(true);
  }

  function openEdit(med: Medication) {
    setEditingMed(med);
    setShowEditTimeline(false);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingMed(null);
    setShowEditTimeline(false);
  }

  if (authLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Medikamente</h1>
          <p className="text-muted-foreground text-sm">
            Bitte anmelden, um Medikamente zu verwalten.
          </p>
        </div>
      </div>
    );
  }

  const activeMeds = medications?.filter((m) => m.active) ?? [];
  const inactiveMeds = medications?.filter((m) => !m.active) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Medikamente</h1>
          <p className="text-muted-foreground text-sm">
            Medikation, Zeitpläne & Einnahmen
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          Medikament
        </Button>
      </div>

      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : !medications?.length ? (
        <div className="bg-card border-border flex h-64 items-center justify-center rounded-xl border">
          <div className="text-muted-foreground flex flex-col items-center gap-2">
            <Pill className="h-8 w-8" />
            <p>Noch keine Medikamente angelegt</p>
            <Button variant="outline" size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Erstes Medikament anlegen
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Active medications */}
          {activeMeds.length > 0 && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {activeMeds.map((med) => (
                  <MedicationCard key={med.id} medication={med} onEdit={openEdit} />
                ))}
              </div>
            </div>
          )}

          {/* Inactive medications */}
          {inactiveMeds.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-muted-foreground text-sm font-medium">
                Inaktiv ({inactiveMeds.length})
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {inactiveMeds.map((med) => (
                  <MedicationCard
                    key={med.id}
                    medication={med}
                    onEdit={openEdit}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* API Endpoint Dialog */}
      <ApiEndpointDialog
        medication={apiMed}
        onClose={() => setApiMed(null)}
      />

      {/* Import Dialog */}
      <IntakeImportDialog
        medicationId={importMedId}
        onClose={() => setImportMedId(null)}
      />

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingMed ? "Medikament bearbeiten" : "Neues Medikament"}
            </DialogTitle>
          </DialogHeader>
          <MedicationForm
            initial={
              editingMed
                ? {
                    id: editingMed.id,
                    name: editingMed.name,
                    dose: editingMed.dose,
                    category: editingMed.category,
                    active: editingMed.active,
                    schedules: editingMed.schedules.map((s) => ({
                      windowStart: s.windowStart,
                      windowEnd: s.windowEnd,
                      label: s.label ?? "",
                      dose: s.dose ?? "",
                    })),
                  }
                : undefined
            }
            onSuccess={closeDialog}
            onCancel={editingMed ? undefined : closeDialog}
          />

          {editingMed && (
            <div className="mt-4 space-y-3 border-t pt-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowEditTimeline((prev) => !prev)}
                >
                  {showEditTimeline
                    ? "Einnahme-Verlauf ausblenden"
                    : "Einnahme-Verlauf anzeigen"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setImportMedId(editingMed.id)}
                >
                  <Upload className="mr-1 h-3.5 w-3.5" />
                  Import
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setApiMed({ id: editingMed.id, name: editingMed.name })
                  }
                >
                  <Terminal className="mr-1 h-3.5 w-3.5" />
                  API
                </Button>
              </div>

              {showEditTimeline && (
                <div className="bg-card border-border rounded-lg border p-3">
                  <IntakeTimeline
                    medicationId={editingMed.id}
                    medicationName={editingMed.name}
                  />
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function IntakeImportDialog({
  medicationId,
  onClose,
}: {
  medicationId: string | null;
  onClose: () => void;
}) {
  const [jsonText, setJsonText] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [resultType, setResultType] = useState<"success" | "error" | null>(
    null,
  );
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const queryClient = useQueryClient();

  function handleClose() {
    setJsonText("");
    setResult(null);
    setResultType(null);
    setSelectedFileName(null);
    setFileInputKey((prev) => prev + 1);
    onClose();
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setResult(null);
    setResultType(null);

    try {
      const content = await file.text();
      JSON.parse(content);
      setJsonText(content);
      setSelectedFileName(file.name);
      setResult(`Datei "${file.name}" geladen`);
      setResultType("success");
    } catch {
      setResult("Datei enthält kein gültiges JSON");
      setResultType("error");
    }
  }

  async function handleImport() {
    if (!medicationId || !jsonText.trim()) return;
    setImporting(true);
    setResult(null);
    setResultType(null);

    try {
      let data = JSON.parse(jsonText.trim());
      // Support both array and object-with-array
      if (!Array.isArray(data)) {
        const arrKey = Object.keys(data).find((k) => Array.isArray(data[k]));
        if (arrKey) data = data[arrKey];
        else throw new Error("Kein Array gefunden");
      }

      const res = await fetch(
        `/api/medications/${medicationId}/intake/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      );

      const json = await res.json();
      if (res.ok) {
        const d = json.data;
        setResult(
          `${d.imported} Einnahmen importiert` +
            (d.skippedDuplicates > 0
              ? `, ${d.skippedDuplicates} Duplikate übersprungen`
              : "") +
            (d.skippedInvalid > 0
              ? `, ${d.skippedInvalid} ungültige Einträge übersprungen`
              : ""),
        );
        setResultType("success");
        queryClient.invalidateQueries({ queryKey: ["medications"] });
      } else {
        setResult(json.error || "Import fehlgeschlagen");
        setResultType("error");
      }
    } catch (err) {
      setResult(
        err instanceof SyntaxError
          ? "Ungültiges JSON-Format"
          : (err as Error).message || "Import fehlgeschlagen",
      );
      setResultType("error");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={!!medicationId} onOpenChange={() => handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Einnahmen importieren</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            JSON-Array mit Einnahme-Daten einfügen. Erwartetes Format:
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="intake-import-file" className="text-xs font-medium">
              JSON-Datei hochladen
            </Label>
            <input
              key={fileInputKey}
              id="intake-import-file"
              type="file"
              accept="application/json,.json"
              onChange={handleFileSelect}
              className="border-input bg-background text-foreground file:bg-muted file:text-foreground w-full cursor-pointer rounded-md border text-sm file:mr-2 file:border-0 file:px-3 file:py-2"
            />
            {selectedFileName && (
              <p className="text-muted-foreground text-xs">
                Ausgewählt: {selectedFileName}
              </p>
            )}
          </div>
          <pre className="bg-muted text-muted-foreground rounded-lg p-3 text-xs">
            {`[
  {"datum": "2026-02-14", "uhrzeit": "10:27:43", "zaehler": 523},
  {"datum": "2026-02-14", "uhrzeit": "23:33:42", "zaehler": 524}
]`}
          </pre>
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder="JSON hier einfügen..."
            rows={8}
            className="border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 font-mono text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
          {result && (
            <p
              className={`text-sm ${resultType === "success" ? "text-dracula-green" : "text-destructive"}`}
            >
              {result}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={handleClose}>
              Schließen
            </Button>
            <Button
              onClick={handleImport}
              disabled={importing || !jsonText.trim()}
            >
              {importing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <Upload className="mr-2 h-4 w-4" />
              Importieren
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ApiEndpointDialog({
  medication,
  onClose,
}: {
  medication: { id: string; name: string } | null;
  onClose: () => void;
}) {
  type ExampleType = "curl" | "wget" | "fetch" | "powershell";

  const [enabled, setEnabled] = useState(false);
  const [activeTokenCount, setActiveTokenCount] = useState(0);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [exampleType, setExampleType] = useState<ExampleType>("curl");

  function handleClose() {
    setEnabled(false);
    setActiveTokenCount(0);
    setToken(null);
    setMsg(null);
    setCopied(null);
    setExampleType("curl");
    onClose();
  }

  const loadStatus = useCallback(async () => {
    if (!medication) return;
    setLoadingStatus(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/medications/${medication.id}/api-endpoint`);
      if (res.ok) {
        const json = await res.json();
        setEnabled(json.data.enabled === true);
        setActiveTokenCount(json.data.activeTokenCount ?? 0);
      } else {
        const json = await res.json();
        setMsg(json.error || "Status konnte nicht geladen werden");
      }
    } catch {
      setMsg("Status konnte nicht geladen werden");
    } finally {
      setLoadingStatus(false);
    }
  }, [medication]);

  async function toggleEndpoint(nextEnabled: boolean) {
    if (!medication) return;
    setToggling(true);
    setToken(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/medications/${medication.id}/api-endpoint`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMsg(json.error || "Ändern fehlgeschlagen");
        return;
      }

      setEnabled(json.data.enabled === true);
      if (typeof json.data.activeTokenCount === "number") {
        setActiveTokenCount(json.data.activeTokenCount);
      } else if (!json.data.enabled && typeof json.data.revokedTokenCount === "number") {
        setActiveTokenCount(0);
      }

      if (json.data.token) {
        setToken(json.data.token);
      }

      setMsg(nextEnabled ? "API-Endpoint aktiviert" : "API-Endpoint deaktiviert");
    } catch {
      setMsg("Ändern fehlgeschlagen");
    } finally {
      setToggling(false);
    }
  }

  async function copyText(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  useEffect(() => {
    if (!medication) return;
    void loadStatus();
  }, [medication, loadStatus]);

  const baseUrl =
    typeof window !== "undefined" ? window.location.origin : "https://...";
  const endpoint = `${baseUrl}/api/ingest/medication`;
  const payload = `{"medicationName":"${medication?.name ?? ""}","idempotencyKey":"einnahme-202602191230"}`;
  const curlCmd = `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ${token ?? "DEIN_TOKEN"}" \\
  -H "Content-Type: application/json" \\
  -d '${payload}'`;
  const wgetCmd = `wget --method=POST "${endpoint}" \\
  --header="Authorization: Bearer ${token ?? "DEIN_TOKEN"}" \\
  --header="Content-Type: application/json" \\
  --body-data='${payload}' \\
  -O -`;
  const fetchCmd = `await fetch("${endpoint}", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${token ?? "DEIN_TOKEN"}",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    medicationName: "${medication?.name ?? ""}",
    idempotencyKey: "einnahme-" + Date.now()
  })
});`;
  const powershellCmd = `Invoke-RestMethod -Method Post -Uri "${endpoint}" \\
  -Headers @{ Authorization = "Bearer ${token ?? "DEIN_TOKEN"}" } \\
  -ContentType "application/json" \\
  -Body '${payload}'`;

  const exampleMap: Record<ExampleType, { label: string; value: string }> = {
    curl: { label: "cURL", value: curlCmd },
    wget: { label: "wget", value: wgetCmd },
    fetch: { label: "JavaScript fetch", value: fetchCmd },
    powershell: { label: "PowerShell", value: powershellCmd },
  };
  const selectedExample = exampleMap[exampleType];

  return (
    <Dialog open={!!medication} onOpenChange={() => handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>API-Endpoint: {medication?.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Nutze diesen Endpoint, um Einnahmen per API zu erfassen (z.B. via
            iPhone-Kurzbefehl oder cron-Job).
          </p>

          <div className="bg-muted/40 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">API-Endpoint aktiv</p>
                <p className="text-muted-foreground text-xs">
                  {enabled
                    ? `Aktiv (${activeTokenCount} Token)`
                    : "Deaktiviert"}
                </p>
              </div>
              <Switch
                checked={enabled}
                disabled={loadingStatus || toggling}
                onCheckedChange={(checked) => {
                  void toggleEndpoint(checked);
                }}
              />
            </div>
          </div>

          {/* Endpoint URL */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Endpoint</Label>
            <div className="flex items-center gap-2">
              <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-xs break-all">
                POST {endpoint}
              </code>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => copyText(endpoint, "url")}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            {copied === "url" && (
              <p className="text-dracula-green text-xs">Kopiert!</p>
            )}
          </div>

          {/* Token */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">API-Token</Label>
            {token ? (
              <div className="flex items-center gap-2">
                <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-xs break-all">
                  {token}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => copyText(token, "token")}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                {enabled
                  ? "Endpoint ist aktiv. Vorhandene Tokens bleiben gültig, können aber nicht erneut im Klartext angezeigt werden."
                  : "Aktiviere den Endpoint, um einen neuen Token zu erstellen."}
              </p>
            )}
            {token && (
              <p className="text-muted-foreground text-xs">
                Der Token wird nur bei der Erstellung einmal im Klartext
                angezeigt.
              </p>
            )}
            {copied === "token" && (
              <p className="text-dracula-green text-xs">Kopiert!</p>
            )}
          </div>

          {/* request examples */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs font-medium">Request-Beispiel</Label>
              <Select
                value={exampleType}
                onValueChange={(value) => setExampleType(value as ExampleType)}
              >
                <SelectTrigger size="sm" className="w-[170px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="curl">cURL</SelectItem>
                  <SelectItem value="wget">wget</SelectItem>
                  <SelectItem value="fetch">JavaScript fetch</SelectItem>
                  <SelectItem value="powershell">PowerShell</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="relative">
              <pre className="bg-muted rounded-lg p-3 font-mono text-xs whitespace-pre-wrap break-all">
                {selectedExample.value}
              </pre>
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-1 right-1 h-7 w-7"
                onClick={() => copyText(selectedExample.value, "example")}
              >
                <Copy className="h-3 w-3" />
              </Button>
            </div>
            {copied === "example" && (
              <p className="text-dracula-green text-xs">Kopiert!</p>
            )}
          </div>

          {msg && (
            <p
              className={`text-sm ${msg.includes("aktiv") || msg.includes("deaktiviert") ? "text-dracula-green" : "text-destructive"}`}
            >
              {msg}
            </p>
          )}

          <Button variant="outline" className="w-full" onClick={handleClose}>
            Schließen
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
