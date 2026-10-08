"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  KeyRound,
  Loader2,
  LogOut,
  Pencil,
  Shield,
  ShieldCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { SettingsCardActions } from "@/components/settings/_card-actions";
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
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ListRow } from "@/components/ui/list-row";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { type AdminUser, PasswordInput } from "./_shared";
import { apiGet, apiPost, apiPut } from "@/lib/api/api-fetch";
import {
  recentProofErrorMessage,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";

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
  // Document vault — per-user storage-quota override, edited in GB.
  // Empty string = no override (the instance default applies).
  const [editQuotaGb, setEditQuotaGb] = useState("");
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<UserFilter>("all");
  const [logoutTarget, setLogoutTarget] = useState<AdminUser | null>(null);

  const { data: users } = useQuery({
    queryKey: queryKeys.adminUsers(),
    queryFn: async () => {
      return apiGet<AdminUser[]>("/api/admin/users");
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
      await apiPut(`/api/admin/users/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers() });
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

  // Setting another account's password asks for a fresh proof unless this
  // session signed in or re-proved within five minutes.
  const recentProof = useRecentProof();

  const resetPw = useMutation({
    mutationFn: async ({ id, password }: { id: string; password: string }) => {
      await recentProof.run(() =>
        apiPost(`/api/admin/users/${id}/reset-password`, { password }),
      );
    },
    onSuccess: () => {
      setResetMsg(t("admin.passwordReset"));
      setResetPassword("");
    },
    onError: (err: Error) => {
      setResetMsg(recentProofErrorMessage(err, err.message));
    },
  });

  const forceLogout = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      return apiPost<{ sessionsRevoked: number }>(
        `/api/admin/users/${id}/force-logout`,
      );
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
    setEditQuotaGb(
      u.documentQuotaBytes === null
        ? ""
        : String(Math.round((u.documentQuotaBytes / 1_073_741_824) * 10) / 10),
    );
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
        <Shield className="h-3 w-3" aria-hidden="true" />
        {u.role === "ADMIN" ? t("admin.toUser") : t("admin.toAdmin")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={`min-h-11 min-w-11 px-3 text-xs ${u.mfaEnforced ? "text-success" : ""}`}
        onClick={() =>
          updateUser.mutate({
            id: u.id,
            data: { mfaEnforced: !u.mfaEnforced },
          })
        }
        title={
          u.mfaEnforced
            ? t("admin.mfaEnforcedOnHint")
            : t("admin.mfaEnforcedOffHint")
        }
        aria-label={
          u.mfaEnforced
            ? t("admin.mfaEnforcedOnHint")
            : t("admin.mfaEnforcedOffHint")
        }
        aria-pressed={u.mfaEnforced}
      >
        <ShieldCheck className="h-3 w-3" aria-hidden="true" />
        {u.mfaEnforced ? t("admin.mfaEnforcedOn") : t("admin.mfaEnforcedOff")}
      </Button>
      {/* The three icon tools travel as one group: on a phone the row wraps
          between the labelled toggles and the tools, never leaving the
          sign-out icon alone on a line. */}
      <span className="ml-auto flex items-center gap-1">
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
          className="text-muted-foreground hover:text-foreground min-h-11 min-w-11 px-2 text-xs"
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
      </span>
    </>
  );

  return (
    <SettingsCard>
      {recentProof.dialog}
      <SettingsCardHeader
        icon={Users}
        title={t("admin.userManagement")}
        description={t("admin.userManagementDescription")}
        titleAccessory={
          filteredUsers ? (
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
          ) : null
        }
      />

      {/* Filter toolbar. It used to sit in the header's status slot, which is
          where the neighbouring sections put a primary, a destructive, and a
          badge — three different meanings for one position. */}
      <div
        className="flex flex-wrap items-center gap-1.5"
        data-slot="admin-users-filter"
      >
        {(["all", "admin", "user"] as const).map((value) => (
          <Button
            key={value}
            // Neutral pills: the selected filter is a state, not a call to
            // action, so it never takes the primary fill.
            variant={filter === value ? "secondary" : "outline"}
            size="sm"
            className="min-h-11 min-w-11 px-3 text-xs sm:min-h-9"
            onClick={() => setFilter(value)}
            aria-pressed={filter === value}
          >
            {t(`admin.section.users.filter.${value}`)}
          </Button>
        ))}
      </div>

      {filteredUsers ? (
        filteredUsers.length === 0 ? (
          // v1.4.15 phase-C5: dedicated empty state. The previous build
          // rendered an empty `<tbody>` so an admin filter that returned
          // no rows produced a blank rectangle; the icon + filter-aware
          // copy + "Show all users" CTA make the state explicit.
          <div>
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
            <div className="hidden overflow-x-auto md:block">
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
                {/* `admin-user-rows` names the read accounts. The section
                    renders an empty state instead when the list is empty and
                    nothing at all while the query is in flight, so the marker
                    stands for answered data. The mobile card list below
                    carries it too, so a wait on it holds at any viewport. */}
                <tbody
                  data-slot="admin-user-rows"
                  className="divide-border divide-y"
                >
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
              className="space-y-2 md:hidden"
              data-slot="admin-user-rows"
              data-testid="admin-users-mobile-list"
            >
              {filteredUsers.map((u) => (
                <ListRow
                  asChild
                  key={u.id}
                  className="bg-muted/30 border-border"
                >
                  <li>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">
                            {u.username}
                          </span>
                          <Badge
                            variant={
                              u.role === "ADMIN" ? "default" : "secondary"
                            }
                            className="text-xs"
                          >
                            {u.role}
                          </Badge>
                        </div>
                        <p className="text-muted-foreground truncate text-xs">
                          {u.email || "—"}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {t("admin.userPasskeys")}: {u.passkeyCount} ·{" "}
                          {formatDate(u.createdAt)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {renderUserActions(u)}
                    </div>
                  </li>
                </ListRow>
              ))}
            </ul>
          </>
        )
      ) : (
        <div className="flex items-center gap-2">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
          <span className="text-muted-foreground text-sm">
            {t("admin.loadingUsers")}
          </span>
        </div>
      )}

      {/* Edit Dialog */}
      {editingUser && (
        <div className="bg-muted/50 space-y-3 rounded-lg p-3">
          <h3 className="text-sm font-semibold">
            {t("admin.editUserTitle", { name: editingUser.username })}
          </h3>
          {/* v1.16.4 — a real form so Enter in the username / email
              fields submits; mirrors the dialog convention. */}
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (updateUser.isPending) return;
              const quotaTrimmed = editQuotaGb.trim();
              const quotaParsed = Number(quotaTrimmed);
              updateUser.mutate({
                id: editingUser.id,
                data: {
                  username: editUsername,
                  email: editEmail || null,
                  // Empty clears the override; a value clamps to the same
                  // bounds the server schema enforces (0.1–1024 GB).
                  documentQuotaBytes:
                    quotaTrimmed === "" || !Number.isFinite(quotaParsed)
                      ? null
                      : Math.round(
                          Math.min(1024, Math.max(0.1, quotaParsed)) *
                            1_073_741_824,
                        ),
                },
              });
            }}
          >
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
            <div className="space-y-1">
              <Label htmlFor="edit-document-quota">
                {t("admin.userDocumentQuota")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="edit-document-quota"
                  type="number"
                  inputMode="decimal"
                  min={0.1}
                  max={1024}
                  step={0.1}
                  className="w-28 text-right tabular-nums"
                  value={editQuotaGb}
                  onChange={(e) => setEditQuotaGb(e.target.value)}
                  placeholder={t("admin.userDocumentQuotaDefault")}
                  autoComplete="off"
                  data-lpignore="true"
                  data-1p-ignore="true"
                />
                <span className="text-muted-foreground text-xs">GB</span>
              </div>
              <p className="text-muted-foreground text-xs">
                {t("admin.userDocumentQuotaHint")}
              </p>
            </div>
            {updateUser.isError && (
              <p className="text-destructive text-sm">
                {(updateUser.error as Error).message}
              </p>
            )}
            <SettingsCardActions>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                onClick={() => setEditingUser(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                size="sm"
                className="min-h-11 sm:min-h-9"
                disabled={updateUser.isPending}
                aria-busy={updateUser.isPending || undefined}
              >
                {updateUser.isPending && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                )}
                {t("common.save")}
              </Button>
            </SettingsCardActions>
          </form>
        </div>
      )}

      {/* Password Reset Dialog */}
      {resetUser && (
        <div className="bg-muted/50 space-y-3 rounded-lg p-3">
          <h3 className="text-sm font-semibold">
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
            {resetMsg && (
              <p
                className={`text-sm ${resetMsg === t("admin.passwordReset") ? "text-success" : "text-destructive"}`}
              >
                {resetMsg}
              </p>
            )}
            <SettingsCardActions>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                onClick={() => setResetUser(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                className="min-h-11 sm:min-h-9"
                disabled={resetPw.isPending || !resetPassword}
                onClick={() =>
                  resetPw.mutate({
                    id: resetUser.id,
                    password: resetPassword,
                  })
                }
              >
                {resetPw.isPending && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                )}
                {t("admin.reset")}
              </Button>
            </SettingsCardActions>
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
              variant="destructive"
              disabled={forceLogout.isPending}
              aria-busy={forceLogout.isPending || undefined}
            >
              {forceLogout.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("admin.section.users.forceLogout")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  );
}
