"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Pencil, Shield, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordStrength } from "@/components/ui/password-strength";
import { formatDate } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { type AdminUser, PasswordInput } from "./_shared";

export function UserManagementSection({
  id,
  currentUserId,
}: {
  id: string;
  currentUserId: string;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
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
      if (!res.ok) throw new Error(json.error || t("common.error"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      setEditingUser(null);
      toast.success(t("common.saved"));
    },
    onError: (err) => {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("admin.settingsSaveError"),
      );
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
      if (!res.ok) throw new Error(json.error || t("common.error"));
    },
    onSuccess: () => {
      setResetMsg(t("admin.passwordReset"));
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
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <Users className="text-primary h-5 w-5" />
        <h2 className="text-lg font-semibold">{t("admin.userManagement")}</h2>
        {users && (
          <Badge variant="secondary" className="text-xs">
            {users.length}
          </Badge>
        )}
      </div>

      {users ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-xs">
                <th className="px-3 py-2 text-left font-medium">
                  {t("admin.users")}
                </th>
                <th className="px-3 py-2 text-left font-medium">
                  {t("admin.userEmail")}
                </th>
                <th className="px-3 py-2 text-center font-medium">
                  {t("admin.userRole")}
                </th>
                <th className="px-3 py-2 text-center font-medium">
                  {t("admin.userPasskeys")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("admin.userCreated")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("admin.userActions")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {users.map((u, i) => (
                <tr key={u.id} className={i % 2 === 0 ? "bg-muted/30" : ""}>
                  <td className="px-3 py-2 font-medium">{u.username}</td>
                  <td className="text-muted-foreground px-3 py-2 text-xs">
                    {u.email || "—"}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <Badge
                      variant={u.role === "ADMIN" ? "default" : "secondary"}
                      className="text-xs"
                    >
                      {u.role}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-center">{u.passkeyCount}</td>
                  <td className="text-muted-foreground px-3 py-2 text-right text-xs whitespace-nowrap">
                    {formatDate(u.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
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
                            ? t("admin.ownRoleUnchangeable")
                            : u.role === "ADMIN"
                              ? t("admin.demoteToUser")
                              : t("admin.promoteToAdmin")
                        }
                      >
                        <Shield className="mr-1 h-3 w-3" />
                        {u.role === "ADMIN"
                          ? t("admin.toUser")
                          : t("admin.toAdmin")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => startEdit(u)}
                      >
                        <Pencil className="mr-1 h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => startReset(u)}
                      >
                        <KeyRound className="mr-1 h-3 w-3" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">
            {t("admin.loadingUsers")}
          </span>
        </div>
      )}

      {/* Edit Dialog */}
      {editingUser && (
        <div className="bg-muted/80 mt-4 rounded-lg p-4">
          <h3 className="mb-3 text-sm font-medium">
            {t("admin.editUserTitle", { name: editingUser.username })}
          </h3>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="edit-username">{t("auth.username")}</Label>
              <Input
                id="edit-username"
                value={editUsername}
                onChange={(e) => setEditUsername(e.target.value)}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-email">{t("admin.userEmail")}</Label>
              <Input
                id="edit-email"
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                placeholder={t("common.optional")}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
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
                {t("common.save")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditingUser(null)}
              >
                {t("common.cancel")}
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
          <h3 className="mb-3 text-sm font-medium">
            {t("admin.resetPasswordTitle", { name: resetUser.username })}
          </h3>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="reset-pw">{t("admin.newPassword")}</Label>
              <PasswordInput
                id="reset-pw"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder={t("admin.newPasswordPlaceholder")}
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
                {t("admin.reset")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setResetUser(null)}
              >
                {t("common.cancel")}
              </Button>
            </div>
            {resetMsg && (
              <p
                className={`text-sm ${resetMsg === t("admin.passwordReset") ? "text-dracula-green" : "text-destructive"}`}
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
