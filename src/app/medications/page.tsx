"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { MedicationForm } from "@/components/medications/medication-form";
import { MedicationCard } from "@/components/medications/medication-card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MoreHorizontal,
  Loader2,
  Plus,
  Pill,
  Upload,
  Copy,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

interface Schedule {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
}

interface Medication {
  id: string;
  name: string;
  dose: string;
  category: string;
  active: boolean;
  notificationsEnabled: boolean;
  pausedAt: string | null;
  lastTakenAt: string | null;
  schedules: Schedule[];
}

export default function MedicationsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { t } = useTranslations();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMed, setEditingMed] = useState<Medication | null>(null);
  const [importMedId, setImportMedId] = useState<string | null>(null);
  const [apiMed, setApiMed] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const {
    data: medications,
    isLoading,
    isError,
    refetch: refetchMedications,
  } = useQuery({
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
    setDialogOpen(true);
  }

  function openEdit(med: Medication) {
    setEditingMed(med);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingMed(null);
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
      <div className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("medications.title")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("medications.loginRequired")}
          </p>
        </div>
      </div>
    );
  }

  const byName = (a: Medication, b: Medication) =>
    a.name.localeCompare(b.name, "de", { sensitivity: "base" });

  const activeMeds = (medications?.filter((m) => m.active) ?? []).sort(byName);
  const inactiveMeds = (medications?.filter((m) => !m.active) ?? []).sort(
    byName,
  );

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("medications.title")}
          </h1>
          <p className="text-muted-foreground hidden text-sm sm:block">
            {t("medications.subtitle")}
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          {t("medications.addMedication")}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : isError ? (
        <div className="bg-card border-border flex h-64 items-center justify-center rounded-xl border">
          <div className="flex flex-col items-center gap-3">
            <p className="text-muted-foreground text-sm">
              {t("medications.loadFailed")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetchMedications()}
            >
              {t("medications.retryLoad")}
            </Button>
          </div>
        </div>
      ) : !medications?.length ? (
        <div className="bg-card border-border flex h-64 items-center justify-center rounded-xl border">
          <div className="text-muted-foreground flex flex-col items-center gap-2">
            <Pill className="h-8 w-8" />
            <p>{t("medications.noMedicationsYet")}</p>
            <Button variant="outline" size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("medications.firstMedication")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Active medications */}
          {activeMeds.length > 0 && (
            <div className="space-y-3.5">
              <div className="grid gap-4 sm:grid-cols-2">
                {activeMeds.map((med) => (
                  <MedicationCard
                    key={med.id}
                    medication={med}
                    onEdit={openEdit}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Inactive medications */}
          {inactiveMeds.length > 0 && (
            <div className="space-y-3.5">
              <h2 className="text-muted-foreground text-sm font-medium">
                {t("common.inactive")} ({inactiveMeds.length})
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
      <ApiEndpointDialog medication={apiMed} onClose={() => setApiMed(null)} />

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
              {editingMed
                ? t("medications.editMedication")
                : t("medications.newMedication")}
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
                    notificationsEnabled: editingMed.notificationsEnabled,
                    schedules: editingMed.schedules.map((s) => ({
                      windowStart: s.windowStart,
                      windowEnd: s.windowEnd,
                      label: s.label ?? "",
                      dose: s.dose ?? "",
                      ...parseScheduleRecurrence(s.daysOfWeek),
                    })),
                  }
                : undefined
            }
            editActions={
              editingMed
                ? {
                    onImportIntakes: () => setImportMedId(editingMed.id),
                    onApiAccess: () =>
                      setApiMed({
                        id: editingMed.id,
                        name: editingMed.name,
                      }),
                  }
                : undefined
            }
            onSuccess={closeDialog}
            onCancel={closeDialog}
          />
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
  const { t } = useTranslations();
  const [jsonText, setJsonText] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [resultType, setResultType] = useState<"success" | "error" | null>(
    null,
  );
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const queryClient = useQueryClient();

  function resetImportForm() {
    setJsonText("");
    setResult(null);
    setResultType(null);
    setSelectedFileName(null);
    setFileInputKey((prev) => prev + 1);
  }

  function handleClose() {
    resetImportForm();
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
      setResult(t("medications.importFileLoaded", { name: file.name }));
      setResultType("success");
    } catch {
      setResult(t("medications.importInvalidJson"));
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
        else throw new Error(t("medications.importNoArray"));
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
          t("medications.importResult", { imported: d.imported }) +
            (d.skippedDuplicates > 0
              ? `, ${t("medications.importDuplicatesSkipped", { count: d.skippedDuplicates })}`
              : "") +
            (d.skippedInvalid > 0
              ? `, ${t("medications.importInvalidSkipped", { count: d.skippedInvalid })}`
              : ""),
        );
        setResultType("success");
        void invalidateKeys(queryClient, medicationDependentKeys);
      } else {
        setResult(json.error || t("medications.importFailed"));
        setResultType("error");
      }
    } catch (err) {
      setResult(
        err instanceof SyntaxError
          ? t("medications.importInvalidFormat")
          : (err as Error).message || t("medications.importFailed"),
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
          <DialogTitle>{t("medications.importIntakes")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            {t("medications.importDescription")}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="intake-import-file" className="text-xs font-medium">
              {t("medications.importUploadFile")}
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
                {t("medications.importSelected", { name: selectedFileName })}
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
            placeholder={t("medications.importPaste")}
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
          <div className="flex items-center justify-between gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  disabled={importing}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={resetImportForm}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {t("common.reset")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={handleClose}
                disabled={importing}
              >
                {t("common.cancel")}
              </Button>
              <Button
                onClick={handleImport}
                disabled={importing || !jsonText.trim()}
              >
                {importing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Upload className="mr-2 h-4 w-4" />
                {t("common.import")}
              </Button>
            </div>
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
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  type ExampleType = "curl" | "wget" | "fetch" | "powershell";

  const apiEndpointKey = ["medication-api-endpoint", medication?.id];

  type ApiEndpointStatus = { enabled: boolean; activeTokenCount: number };

  const {
    data: status,
    isFetching: loadingStatus,
    refetch: refetchStatus,
    error: statusError,
  } = useQuery<ApiEndpointStatus>({
    queryKey: apiEndpointKey,
    queryFn: async () => {
      const res = await fetch(
        `/api/medications/${medication!.id}/api-endpoint`,
      );
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || t("medications.statusLoadFailed"));
      }
      return {
        enabled: json.data.enabled === true,
        activeTokenCount: json.data.activeTokenCount ?? 0,
      };
    },
    enabled: !!medication,
    staleTime: 0,
    gcTime: 0,
  });

  const enabled = status?.enabled ?? false;
  const activeTokenCount = status?.activeTokenCount ?? 0;

  const [token, setToken] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [exampleType, setExampleType] = useState<ExampleType>("curl");

  const displayMsg =
    msg ?? (statusError instanceof Error ? statusError.message : null);

  function handleClose() {
    queryClient.removeQueries({ queryKey: apiEndpointKey });
    setToken(null);
    setMsg(null);
    setCopied(null);
    setExampleType("curl");
    onClose();
  }

  async function toggleEndpoint(nextEnabled: boolean) {
    if (!medication) return;
    setToggling(true);
    setToken(null);
    setMsg(null);
    try {
      const res = await fetch(
        `/api/medications/${medication.id}/api-endpoint`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: nextEnabled }),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        setMsg(json.error || t("medications.changeFailed"));
        return;
      }

      const nextStatus: ApiEndpointStatus = {
        enabled: json.data.enabled === true,
        activeTokenCount:
          typeof json.data.activeTokenCount === "number"
            ? json.data.activeTokenCount
            : !json.data.enabled
              ? 0
              : (status?.activeTokenCount ?? 0),
      };
      queryClient.setQueryData<ApiEndpointStatus>(apiEndpointKey, nextStatus);

      if (json.data.token) {
        setToken(json.data.token);
      }

      setMsg(
        nextEnabled
          ? t("medications.apiEndpointActivated")
          : t("medications.apiEndpointDeactivated"),
      );
    } catch {
      setMsg(t("medications.changeFailed"));
    } finally {
      setToggling(false);
    }
  }

  async function copyText(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

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
          <DialogTitle>
            {t("medications.apiEndpointTitle", {
              name: medication?.name ?? "",
            })}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            {t("medications.apiEndpointDescription")}
          </p>

          <div className="bg-muted/40 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  {t("medications.apiEndpointActive")}
                </p>
                <p className="text-muted-foreground text-xs">
                  {enabled
                    ? t("medications.apiTokenCount", {
                        count: activeTokenCount,
                      })
                    : t("common.disabled")}
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
              <p className="text-dracula-green text-xs">{t("common.copied")}</p>
            )}
          </div>

          {/* Token */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              {t("medications.apiToken")}
            </Label>
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
                  ? t("medications.apiTokenActiveHint")
                  : t("medications.apiTokenActivateHint")}
              </p>
            )}
            {token && (
              <p className="text-muted-foreground text-xs">
                {t("medications.apiTokenOnceHint")}
              </p>
            )}
            {copied === "token" && (
              <p className="text-dracula-green text-xs">{t("common.copied")}</p>
            )}
          </div>

          {/* request examples */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs font-medium">
                {t("medications.requestExample")}
              </Label>
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
              <pre className="bg-muted rounded-lg p-3 font-mono text-xs break-all whitespace-pre-wrap">
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
              <p className="text-dracula-green text-xs">{t("common.copied")}</p>
            )}
          </div>

          {displayMsg && (
            <p
              className={`text-sm ${displayMsg === t("medications.apiEndpointActivated") || displayMsg === t("medications.apiEndpointDeactivated") ? "text-dracula-green" : "text-destructive"}`}
            >
              {displayMsg}
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  disabled={loadingStatus || toggling}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  onClick={() => {
                    void refetchStatus();
                  }}
                  disabled={loadingStatus || toggling}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t("medications.retryLoad")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button onClick={handleClose}>{t("common.close")}</Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
