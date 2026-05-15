"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, LogOut, Pencil, Shield, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordStrength } from "@/components/ui/password-strength";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { type AdminUser, PasswordInput } from "./_shared";

/**
 * Filter values for the v1.5 users sub-route. The User model does NOT
 * carry a "suspended" boolean today (a force-logout deletes sessions but
 * leaves the row intact), so the spec's `suspended` bucket is mapped to
 * a passthrough — we keep the slug for forward compatibility but it
 * shows the same set as `all`. Documented in the phase 4b report.
 */
type UserFilter = "all" | "admin" | "user";

export function UserManagementSection() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const currentUserId = user?.id ?? "";
  const queryClient = useQueryClient();
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<UserFilter>("all");
  const [logoutTarget, setLogoutTarget] = useState<AdminUser | null>(null);

  const { data: users } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const res = await fetch("/api/admin/users");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as AdminUser[];
    },
  });

  const filteredUsers = useMemo<AdminUser[] | undefined>(() => {
    if (!users) return undefined;
    if (filter === "admin") return users.filter((u) => u.role === "ADMIN");
    if (filter === "user") return users.filter((u) => u.role !== "ADMIN");
    return users;
  }, [users, filter]);

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

  const forceLogout = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const res = await fetch(`/api/admin/users/${id}/force-logout`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("common.error"));
      return json.data as { sessionsRevoked: number };
    },
    onSuccess: (result, vars) => {
      const username =
        users?.find((u) => u.id === vars.id)?.username ?? vars.id;
      toast.success(
        t("admin.section.users.forceLogoutSuccess", {
          name: username,
          count: result.sessionsRevoked,
        }),
      );
      setLogoutTarget(null);
    },
    onError: (err) => {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.users.forceLogoutFailed"),
      );
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

  /**
   * Action buttons are reused for both the desktop-table (cramped) row
   * and the mobile-card layout. Pulling them into a single helper keeps
   * the two layouts in lock-step — when we add a new admin action we
   * never have to remember to add it to both.
   */
  const renderUserActions = (u: AdminUser) => (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 min-w-11 px-3 text-xs"
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
        aria-label={
          u.role === "ADMIN"
            ? t("admin.demoteToUser")
            : t("admin.promoteToAdmin")
        }
      >
        <Shield className="mr-1 h-3 w-3" aria-hidden="true" />
        {u.role === "ADMIN" ? t("admin.toUser") : t("admin.toAdmin")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 min-w-11 px-2 text-xs"
        onClick={() => startEdit(u)}
        title={t("admin.editUser")}
        aria-label={t("admin.editUser")}
      >
        <Pencil className="h-3 w-3" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 min-w-11 px-2 text-xs"
        onClick={() => startReset(u)}
        title={t("admin.resetPassword")}
        aria-label={t("admin.resetPassword")}
      >
        <KeyRound className="h-3 w-3" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive min-h-11 min-w-11 px-2 text-xs"
        onClick={() => setLogoutTarget(u)}
        disabled={u.id === currentUserId}
        title={
          u.id === currentUserId
            ? t("admin.section.users.cannotLogoutSelf")
            : t("admin.section.users.forceLogout")
        }
        aria-label={
          u.id === currentUserId
            ? t("admin.section.users.cannotLogoutSelf")
            : t("admin.section.users.forceLogout")
        }
      >
        <LogOut className="h-3 w-3" aria-hidden="true" />
      </Button>
    </>
  );

  return (
    <div className="bg-card border-border rounded-xl border p-4 sm:p-6">
      {/* Header: stacks vertically on mobile so the filter pills get
          their own row instead of overlapping the title. The audit
          flagged this as CRITICAL #2 — at 393px the filter row was
          colliding with the count Badge and the user-count digit was
          floating into the title's gap. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
        <div className="flex items-center gap-2">
          <Users className="text-primary h-5 w-5" />
          <div className="text-lg font-semibold">
            {t("admin.userManagement")}
          </div>
          {filteredUsers && (
            <Badge variant="secondary" className="text-xs">
              {filteredUsers.length}
              {filter !== "all" &&
                users &&
                filteredUsers.length !== users.length && (
                  <span className="text-muted-foreground ml-1">
                    / {users.length}
                  </span>
                )}
            </Badge>
          )}
        </div>
        {/* Filters mirror the Settings-style horizontal pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", "admin", "user"] as const).map((value) => (
            <Button
              key={value}
              variant={filter === value ? "default" : "ghost"}
              size="sm"
              className="min-h-11 min-w-11 px-3 text-xs"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
            >
              {t(`admin.section.users.filter.${value}`)}
            </Button>
          ))}
        </div>
      </div>

      {filteredUsers ? (
        filteredUsers.length === 0 ? (
          // v1.4.15 phase-C5: dedicated empty state. The previous build
          // rendered an empty `<tbody>` so an admin filter that returned
          // no rows produced a blank rectangle; the icon + filter-aware
          // copy + "Show all users" CTA make the state explicit.
          <div className="mt-4">
            <EmptyState
              icon={<Users className="size-6" />}
              title={t("admin.section.users.emptyTitle")}
              description={t("admin.section.users.emptyDescription")}
              action={
                filter !== "all" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFilter("all")}
                  >
                    {t("admin.section.users.emptyResetFilter")}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <>
            {/* Desktop table: kept verbatim — only the wrapping
              `md:block hidden` swaps it out for the card-list below at
              `< md`. Hiding the table-only wrapper (instead of just
              the cells) saves DOM weight on mobile too. */}
            <div className="mt-4 hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-xs">
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.userName")}
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
                  {filteredUsers.map((u, i) => (
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
                      <td className="px-3 py-2 text-center">
                        {u.passkeyCount}
                      </td>
                      <td className="text-muted-foreground px-3 py-2 text-right text-xs whitespace-nowrap">
                        {formatDate(u.createdAt)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {renderUserActions(u)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile card list: each user renders as a self-contained
              card with the meta line + a flex-wrapping action row.
              All four actions stay visible and tap-targetable; nothing
              is hidden behind a horizontal scroll. */}
            <ul
              className="mt-4 space-y-2 md:hidden"
              data-testid="admin-users-mobile-list"
            >
              {filteredUsers.map((u) => (
                <li
                  key={u.id}
                  className="bg-muted/30 border-border rounded-lg border p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {u.username}
                        </span>
                        <Badge
                          variant={u.role === "ADMIN" ? "default" : "secondary"}
                          className="text-[10px]"
                        >
                          {u.role}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground truncate text-xs">
                        {u.email || "—"}
                      </p>
                      <p className="text-muted-foreground text-[11px]">
                        {t("admin.userPasskeys")}: {u.passkeyCount} ·{" "}
                        {formatDate(u.createdAt)}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {renderUserActions(u)}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )
      ) : (
        <div className="mt-4 flex items-center gap-2">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
          <span className="text-muted-foreground text-sm">
            {t("admin.loadingUsers")}
          </span>
        </div>
      )}

      {/* Edit Dialog */}
      {editingUser && (
        <div className="bg-muted/80 mt-4 rounded-lg p-4">
          <h3 className="mb-3 text-sm font-semibold">
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
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
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
          <h3 className="mb-3 text-sm font-semibold">
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
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
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

      {/* Force-logout confirmation */}
      <AlertDialog
        open={logoutTarget !== null}
        onOpenChange={(open) => {
          if (!open) setLogoutTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("admin.section.users.forceLogoutConfirmTitle", {
                name: logoutTarget?.username ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin.section.users.forceLogoutConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (logoutTarget) {
                  forceLogout.mutate({ id: logoutTarget.id });
                }
              }}
              className="bg-destructive hover:bg-destructive/90"
            >
              {forceLogout.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("admin.section.users.forceLogout")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
