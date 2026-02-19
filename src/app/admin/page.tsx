"use client";

import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Shield,
  Users,
  Settings,
  Loader2,
  KeyRound,
  Pencil,
  AlertTriangle,
  Trash2,
} from "lucide-react";
import { PasswordStrength } from "@/components/ui/password-strength";
import { formatDate } from "@/lib/format";

interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  role: string;
  createdAt: string;
  passkeyCount: number;
}

export default function AdminPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  if (!user || user.role !== "ADMIN") return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Administration</h1>
        <p className="text-muted-foreground text-sm">
          Benutzer und Anwendungseinstellungen verwalten
        </p>
      </div>

      <AppSettingsSection />
      <Separator />
      <UserManagementSection
        queryClient={queryClient}
        currentUserId={user.id}
      />
    </div>
  );
}

/* ─────────────────────── App Settings ─────────────────────── */

function AppSettingsSection() {
  const queryClient = useQueryClient();
  const [wipeMsg, setWipeMsg] = useState<string | null>(null);

  const { data: settings } = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: async () => {
      const res = await fetch("/api/admin/settings");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as { registrationEnabled: boolean };
    },
  });

  const updateSettings = useMutation({
    mutationFn: async (registrationEnabled: boolean) => {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registrationEnabled }),
      });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
  });

  const wipeAllData = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/data", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE ALL" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Fehler");
      return json.data as {
        measurements: number;
        intakeEvents: number;
        medications: number;
      };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries();
      setWipeMsg(
        `Gelöscht: ${data.measurements} Messwerte, ${data.medications} Medikamente, ${data.intakeEvents} Einnahmen`,
      );
    },
    onError: (err: Error) => {
      setWipeMsg(err.message);
    },
  });

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <Settings className="text-primary h-5 w-5" />
        <h2 className="font-semibold">Anwendungseinstellungen</h2>
      </div>
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Registrierung erlauben</p>
            <p className="text-muted-foreground text-xs">
              Wenn deaktiviert, können sich keine neuen Benutzer registrieren.
            </p>
          </div>
          <Switch
            checked={settings?.registrationEnabled ?? true}
            onCheckedChange={(checked) => updateSettings.mutate(checked)}
            disabled={updateSettings.isPending}
          />
        </div>

        <div className="border-border mt-6 rounded-lg border border-dashed p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-orange-400" />
            <div>
              <p className="text-sm font-medium">Alle Daten global löschen</p>
              <p className="text-muted-foreground text-xs">
                Löscht alle Mess-, Medikamenten-, Integrations- und Protokoll-
                Daten aller Benutzer. Benutzerkonten bleiben bestehen.
              </p>
            </div>
          </div>
          <div className="mt-3">
            <Button
              variant="destructive"
              size="sm"
              disabled={wipeAllData.isPending}
              onClick={() => {
                if (
                  confirm(
                    "Wirklich ALLE Daten aller Benutzer löschen? Dieser Vorgang kann nicht rückgängig gemacht werden.",
                  )
                ) {
                  wipeAllData.mutate();
                }
              }}
            >
              {wipeAllData.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3.5 w-3.5" />
              )}
              Alle Daten löschen
            </Button>
          </div>
          {wipeMsg && (
            <p
              className={`mt-2 text-sm ${wipeMsg.startsWith("Gelöscht:") ? "text-dracula-green" : "text-destructive"}`}
            >
              {wipeMsg}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────── User Management ─────────────────────── */

function UserManagementSection({
  queryClient,
  currentUserId,
}: {
  queryClient: ReturnType<typeof useQueryClient>;
  currentUserId: string;
}) {
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  const { data: users } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const res = await fetch("/api/admin/users");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as AdminUser[];
    },
  });

  const updateUser = useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: Record<string, unknown>;
    }) => {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Fehler");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      setEditingUser(null);
    },
  });

  const resetPw = useMutation({
    mutationFn: async ({ id, password }: { id: string; password: string }) => {
      const res = await fetch(`/api/admin/users/${id}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Fehler");
    },
    onSuccess: () => {
      setResetMsg("Passwort wurde zurückgesetzt");
      setResetPassword("");
    },
    onError: (err: Error) => {
      setResetMsg(err.message);
    },
  });

  function startEdit(u: AdminUser) {
    setEditingUser(u);
    setEditUsername(u.username);
    setEditEmail(u.email ?? "");
  }

  function startReset(u: AdminUser) {
    setResetUser(u);
    setResetPassword("");
    setResetMsg(null);
  }

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <Users className="text-primary h-5 w-5" />
        <h2 className="font-semibold">Benutzerverwaltung</h2>
      </div>

      <div className="mt-4 space-y-3">
        {users?.map((u) => (
          <div
            key={u.id}
            className="bg-muted/50 flex items-center justify-between rounded-lg p-4"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{u.username}</span>
                <Badge
                  variant={u.role === "ADMIN" ? "default" : "secondary"}
                  className="text-xs"
                >
                  {u.role}
                </Badge>
              </div>
              <p className="text-muted-foreground text-xs">
                {u.email || "Keine E-Mail"} &middot; Erstellt:{" "}
                {formatDate(u.createdAt)} &middot; {u.passkeyCount} Passkey(s)
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  updateUser.mutate({
                    id: u.id,
                    data: {
                      role: u.role === "ADMIN" ? "USER" : "ADMIN",
                    },
                  })
                }
                disabled={u.id === currentUserId}
                title={
                  u.id === currentUserId
                    ? "Eigene Rolle nicht änderbar"
                    : u.role === "ADMIN"
                      ? "Zu User degradieren"
                      : "Zum Admin befördern"
                }
              >
                <Shield className="mr-1 h-3.5 w-3.5" />
                {u.role === "ADMIN" ? "→ User" : "→ Admin"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => startEdit(u)}>
                <Pencil className="mr-1 h-3.5 w-3.5" />
                Bearbeiten
              </Button>
              <Button variant="ghost" size="sm" onClick={() => startReset(u)}>
                <KeyRound className="mr-1 h-3.5 w-3.5" />
                Passwort
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Edit Dialog */}
      {editingUser && (
        <div className="bg-muted/80 mt-4 rounded-lg p-4">
          <h3 className="mb-3 font-medium">
            Benutzer bearbeiten: {editingUser.username}
          </h3>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="edit-username">Benutzername</Label>
              <Input
                id="edit-username"
                value={editUsername}
                onChange={(e) => setEditUsername(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-email">E-Mail</Label>
              <Input
                id="edit-email"
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={updateUser.isPending}
                onClick={() =>
                  updateUser.mutate({
                    id: editingUser.id,
                    data: {
                      username: editUsername,
                      email: editEmail || null,
                    },
                  })
                }
              >
                {updateUser.isPending && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                )}
                Speichern
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditingUser(null)}
              >
                Abbrechen
              </Button>
              {updateUser.isError && (
                <span className="text-destructive self-center text-sm">
                  {(updateUser.error as Error).message}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Password Reset Dialog */}
      {resetUser && (
        <div className="bg-muted/80 mt-4 rounded-lg p-4">
          <h3 className="mb-3 font-medium">
            Passwort zurücksetzen: {resetUser.username}
          </h3>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="reset-pw">Neues Passwort</Label>
              <Input
                id="reset-pw"
                type="text"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder="Mindestens 12 Zeichen"
              />
              <PasswordStrength password={resetPassword} />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={resetPw.isPending || !resetPassword}
                onClick={() =>
                  resetPw.mutate({
                    id: resetUser.id,
                    password: resetPassword,
                  })
                }
              >
                {resetPw.isPending && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                )}
                Zurücksetzen
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setResetUser(null)}
              >
                Abbrechen
              </Button>
            </div>
            {resetMsg && (
              <p
                className={`text-sm ${resetMsg.includes("zurückgesetzt") ? "text-dracula-green" : "text-destructive"}`}
              >
                {resetMsg}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
