"use client";

/**
 * v1.16.0 — Admin → Invites. Full management surface for registration
 * invite links (formerly a card inside the Users section).
 *
 * Layout:
 *   - Header row: explanatory copy + the single "create" action. TTL +
 *     max-uses selection moved into the create dialog so the section
 *     header stays calm (no 7/14/30 button wall).
 *   - The freshly minted link + QR render INSIDE the dialog as a
 *     one-time "ticket": only the HMAC hash is persisted, so the URL is
 *     copyable exactly now and never again. The UI says so honestly.
 *   - Desktop (md+): a real table — status, created, expiry
 *     (relative + absolute), uses, redemption history, revoke.
 *   - Mobile: stacked cards carrying the same facts.
 *
 * Status model (derived client-side from the row):
 *   revoked > exhausted > expired > active. Revocation is soft
 *   (DELETE sets `revokedAt`), so history rows never disappear.
 *
 * The QR data-URL is rendered inside the mutation (not in an effect):
 * `qrcode`'s `toDataURL` is async, so folding it into `mutationFn`
 * keeps the component free of setState-in-effect churn. The library
 * itself loads via dynamic `import()` at that call site (v1.16.1) —
 * it is only needed the moment an admin mints an invite, so it stays
 * out of the admin route bundle entirely.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Copy, Loader2, Plus, Ticket, Users } from "lucide-react";
import { toast } from "sonner";

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
import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { apiDelete, apiGet, apiPost } from "@/lib/api/api-fetch";

interface InviteRedemptionEntry {
  id: string;
  redeemedAt: string;
  user: { id: string; username: string; email: string | null } | null;
}

interface AdminInvite {
  id: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  uses: number;
  maxUses: number;
  creator: { id: string; username: string } | null;
  consumer: { id: string; username: string } | null;
  redemptions: InviteRedemptionEntry[];
}

interface MintedInvite {
  id: string;
  token: string;
  url: string;
  expiresAt: string;
  qrDataUrl: string;
}

type InviteStatus = "active" | "expired" | "exhausted" | "revoked";

export function deriveInviteStatus(
  invite: Pick<AdminInvite, "uses" | "maxUses" | "expiresAt" | "revokedAt">,
  now: Date,
): InviteStatus {
  if (invite.revokedAt !== null) return "revoked";
  if (invite.uses >= invite.maxUses) return "exhausted";
  if (new Date(invite.expiresAt).getTime() <= now.getTime()) return "expired";
  return "active";
}

const TTL_CHOICES = [7, 14, 30] as const;
const MAX_USES_CAP = 50;

/**
 * Clamp the raw max-uses field to the mintable range (integer 1–50).
 * Shared by the submit path and the blur echo so the admin always sees
 * exactly what the POST will carry. Exported for unit tests.
 */
export function clampMaxUses(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.min(parsed, MAX_USES_CAP)
    : 1;
}

/** Whole days (ceil) from `now` until `iso`; negative when past. */
function daysUntil(iso: string, now: Date): number {
  const ms = new Date(iso).getTime() - now.getTime();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

const STATUS_STYLES: Record<InviteStatus, { dot: string; chip: string }> = {
  // Quiet tinted chips with a colour dot — the dot carries the state at
  // a glance, the tint stays low so a table of mixed states reads calm.
  active: {
    dot: "bg-success",
    chip: "border-success/30 bg-success/10 text-success",
  },
  expired: {
    dot: "bg-muted-foreground/60",
    chip: "border-border bg-muted/40 text-muted-foreground",
  },
  exhausted: {
    dot: "bg-info",
    chip: "border-info/30 bg-info/10 text-info",
  },
  revoked: {
    dot: "bg-destructive",
    chip: "border-destructive/30 bg-destructive/10 text-destructive",
  },
};

function StatusChip({
  status,
  label,
}: {
  status: InviteStatus;
  label: string;
}) {
  const styles = STATUS_STYLES[status];
  return (
    <span
      data-testid={`invite-status-${status}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        styles.chip,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", styles.dot)}
      />
      {label}
    </span>
  );
}

export function InviteTokensSection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [ttlDays, setTtlDays] = useState<number>(7);
  const [maxUses, setMaxUses] = useState<string>("1");
  const [minted, setMinted] = useState<MintedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AdminInvite | null>(null);

  const { data: invites, isError } = useQuery({
    queryKey: queryKeys.adminInvites(),
    queryFn: async () => {
      return apiGet<AdminInvite[]>("/api/admin/invites");
    },
  });

  const create = useMutation({
    mutationKey: queryKeys.adminInvites(),
    mutationFn: async (input: {
      expiresInDays: number;
      maxUses: number;
    }): Promise<MintedInvite> => {
      const data = await apiPost<Omit<MintedInvite, "qrDataUrl">>(
        "/api/admin/invites",
        input,
      );
      // Lazy chunk: qrcode is only ever needed right here, at mint time.
      const QRCode = (await import("qrcode")).default;
      const qrDataUrl = await QRCode.toDataURL(data.url, {
        width: 240,
        margin: 1,
      });
      return { ...data, qrDataUrl };
    },
    onSuccess: (invite) => {
      setMinted(invite);
      toast.success(t("admin.invites.createdToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.adminInvites() });
    },
    onError: () => {
      toast.error(t("admin.invites.createError"));
    },
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      await apiDelete(`/api/admin/invites/${id}`);
    },
    onSuccess: () => {
      toast.success(t("admin.invites.revokedToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.adminInvites() });
    },
    onError: () => {
      toast.error(t("admin.invites.revokeError"));
    },
  });

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success(t("admin.invites.copiedToast"));
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      toast.error(t("admin.invites.copyError"));
    }
  }

  function openCreateDialog() {
    setMinted(null);
    setCopied(false);
    setTtlDays(7);
    setMaxUses("1");
    setCreateOpen(true);
  }

  function submitCreate() {
    create.mutate({ expiresInDays: ttlDays, maxUses: clampMaxUses(maxUses) });
  }

  const now = new Date();

  function statusLabel(status: InviteStatus): string {
    // Literal keys so the i18n call-site coverage guard sees them.
    switch (status) {
      case "active":
        return t("admin.invites.statusActive");
      case "expired":
        return t("admin.invites.statusExpired");
      case "exhausted":
        return t("admin.invites.statusExhausted");
      case "revoked":
        return t("admin.invites.statusRevoked");
    }
  }

  function expiryRelative(invite: AdminInvite, status: InviteStatus): string {
    if (status !== "active") return "—";
    const days = daysUntil(invite.expiresAt, now);
    if (days <= 0) return "—";
    return days === 1
      ? t("admin.invites.expiresInDaysOne")
      : t("admin.invites.expiresInDaysOther", { count: days });
  }

  function redemptionSummary(invite: AdminInvite): string {
    if (invite.redemptions.length === 0) return "—";
    const first = invite.redemptions[0];
    const name = first.user?.username ?? t("admin.invites.redeemerDeleted");
    if (invite.redemptions.length === 1) return name;
    return t("admin.invites.redeemedByMore", {
      username: name,
      count: invite.redemptions.length - 1,
    });
  }

  return (
    <SettingsCard
      as="section"
      aria-labelledby="admin-invites-title"
      data-testid="admin-invites-card"
    >
      <SettingsCardHeader
        icon={Ticket}
        titleId="admin-invites-title"
        title={t("admin.invites.title")}
        description={t("admin.invites.description")}
      />

      {isError && (
        <p className="text-destructive text-sm">
          {t("admin.invites.loadError")}
        </p>
      )}

      {invites && invites.length === 0 && (
        <div>
          <EmptyState
            icon={<Ticket className="size-6" aria-hidden="true" />}
            title={t("admin.invites.emptyTitle")}
            description={t("admin.invites.emptyDescription")}
          />
        </div>
      )}

      {invites && invites.length > 0 && (
        <>
          {/* Desktop table (md+) */}
          <div className="hidden md:block">
            <Table data-testid="admin-invites-table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("admin.invites.colStatus")}</TableHead>
                  <TableHead>{t("admin.invites.colCreated")}</TableHead>
                  <TableHead>{t("admin.invites.colExpires")}</TableHead>
                  <TableHead className="text-right">
                    {t("admin.invites.colUses")}
                  </TableHead>
                  <TableHead>{t("admin.invites.colRedeemedBy")}</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">
                      {t("admin.invites.colActions")}
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((invite) => {
                  const status = deriveInviteStatus(invite, now);
                  const relative = expiryRelative(invite, status);
                  return (
                    <TableRow
                      key={invite.id}
                      data-testid="admin-invite-row"
                      className={cn(
                        status !== "active" && "text-muted-foreground",
                      )}
                    >
                      <TableCell>
                        <StatusChip
                          status={status}
                          label={statusLabel(status)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="leading-tight">
                          <div className="text-sm tabular-nums">
                            {formatDate(invite.createdAt)}
                          </div>
                          <div className="text-muted-foreground text-xs">
                            {t("admin.invites.byCreator", {
                              by: invite.creator?.username ?? "—",
                            })}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="leading-tight">
                          <div className="text-sm tabular-nums">
                            {relative !== "—"
                              ? relative
                              : formatDate(invite.expiresAt)}
                          </div>
                          {relative !== "—" && (
                            <div className="text-muted-foreground text-xs tabular-nums">
                              {formatDate(invite.expiresAt)}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {invite.uses}
                        <span className="text-muted-foreground">
                          {" "}
                          / {invite.maxUses}
                        </span>
                      </TableCell>
                      <TableCell>
                        <RedemptionsCell
                          invite={invite}
                          summary={redemptionSummary(invite)}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        {status === "active" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            aria-label={t("admin.invites.revokeAria")}
                            disabled={revoke.isPending}
                            onClick={() => setRevokeTarget(invite)}
                            data-testid="admin-invite-revoke"
                          >
                            <Ban className="size-4" aria-hidden="true" />
                            {t("admin.invites.revoke")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards (<md) */}
          <ul className="space-y-2 md:hidden">
            {invites.map((invite) => {
              const status = deriveInviteStatus(invite, now);
              const relative = expiryRelative(invite, status);
              return (
                <li
                  key={invite.id}
                  className="border-border rounded-lg border p-3"
                  data-testid="admin-invite-row"
                >
                  <div className="flex items-center justify-between gap-2">
                    <StatusChip status={status} label={statusLabel(status)} />
                    <span className="text-sm tabular-nums">
                      {invite.uses}
                      <span className="text-muted-foreground">
                        {" "}
                        / {invite.maxUses}
                      </span>
                    </span>
                  </div>
                  <dl className="text-muted-foreground mt-2 space-y-1 text-xs">
                    <div className="flex justify-between gap-2">
                      <dt>{t("admin.invites.colCreated")}</dt>
                      <dd className="text-right tabular-nums">
                        {formatDate(invite.createdAt)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>{t("admin.invites.colExpires")}</dt>
                      <dd className="text-right tabular-nums">
                        {relative !== "—" ? `${relative} · ` : ""}
                        {formatDate(invite.expiresAt)}
                      </dd>
                    </div>
                    {invite.redemptions.length > 0 && (
                      <div className="flex justify-between gap-2">
                        <dt>{t("admin.invites.colRedeemedBy")}</dt>
                        <dd className="text-foreground text-right">
                          {redemptionSummary(invite)}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {status === "active" && (
                    <div className="mt-2 flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        disabled={revoke.isPending}
                        onClick={() => setRevokeTarget(invite)}
                      >
                        <Ban className="size-4" aria-hidden="true" />
                        {t("admin.invites.revoke")}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* Create dialog — selection first, then the one-time ticket. */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setMinted(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          {minted === null ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("admin.invites.createTitle")}</DialogTitle>
                <DialogDescription>
                  {t("admin.invites.createDescription")}
                </DialogDescription>
              </DialogHeader>
              {/* v1.16.4 — a real form so Enter in the max-uses field
                  submits; mirrors the intake-edit dialog convention. */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (create.isPending) return;
                  submitCreate();
                }}
                className="space-y-4"
              >
                <div className="space-y-4">
                  <fieldset>
                    <legend className="text-sm font-medium">
                      {t("admin.invites.ttlLegend")}
                    </legend>
                    <div
                      className="mt-2 grid grid-cols-3 gap-2"
                      role="radiogroup"
                    >
                      {TTL_CHOICES.map((days) => (
                        <button
                          key={days}
                          type="button"
                          role="radio"
                          aria-checked={ttlDays === days}
                          onClick={() => setTtlDays(days)}
                          data-testid={`admin-invites-ttl-${days}`}
                          className={cn(
                            "min-h-11 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                            ttlDays === days
                              ? "border-primary/50 bg-primary/10 text-primary"
                              : "border-border text-foreground hover:bg-accent",
                          )}
                        >
                          {t("admin.invites.createDays", { days })}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <div className="space-y-1.5">
                    <Label htmlFor="admin-invites-max-uses">
                      {t("admin.invites.maxUsesLabel")}
                    </Label>
                    <Input
                      id="admin-invites-max-uses"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_USES_CAP}
                      step={1}
                      value={maxUses}
                      onChange={(e) => setMaxUses(e.target.value)}
                      onBlur={() => {
                        // Echo the submit-time clamp (1–50, integer) into
                        // the field so the admin sees what will be minted.
                        setMaxUses(String(clampMaxUses(maxUses)));
                      }}
                      className="w-24 tabular-nums"
                      data-testid="admin-invites-max-uses"
                    />
                    <p className="text-muted-foreground text-xs">
                      {t("admin.invites.maxUsesHint")}
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    type="submit"
                    disabled={create.isPending}
                    aria-busy={create.isPending || undefined}
                    data-testid="admin-invites-submit-create"
                  >
                    {create.isPending ? (
                      <Loader2
                        className="size-4 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      <Ticket className="size-4" aria-hidden="true" />
                    )}
                    {t("admin.invites.createConfirm")}
                  </Button>
                </DialogFooter>
              </form>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t("admin.invites.tokenTitle")}</DialogTitle>
                <DialogDescription>
                  {t("admin.invites.tokenOnceHint")}
                </DialogDescription>
              </DialogHeader>
              {/* The ticket — dashed edge marks the one-time nature. */}
              <div
                className="border-primary/40 bg-background rounded-xl border border-dashed p-4"
                data-testid="admin-invites-minted"
              >
                <div className="flex flex-col items-center gap-4">
                  {/* eslint-disable-next-line @next/next/no-img-element -- data-URL QR, no remote loader involved */}
                  <img
                    src={minted.qrDataUrl}
                    alt={t("admin.invites.qrAlt")}
                    width={176}
                    height={176}
                    className="rounded-lg bg-white p-2"
                  />
                  <p
                    className="bg-muted w-full overflow-x-auto rounded-md p-2 text-center font-mono text-xs break-all select-all"
                    data-testid="admin-invites-minted-url"
                  >
                    {minted.url}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => copyUrl(minted.url)}
                    data-testid="admin-invites-copy"
                  >
                    {copied ? (
                      <Check
                        className="text-success size-4"
                        aria-hidden="true"
                      />
                    ) : (
                      <Copy className="size-4" aria-hidden="true" />
                    )}
                    {t("admin.invites.copyLink")}
                  </Button>
                </div>
              </div>
              <p className="text-muted-foreground text-xs">
                {t("admin.invites.hashExplainer")}
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation */}
      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("admin.invites.revokeConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin.invites.revokeConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("admin.invites.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revokeTarget) revoke.mutate(revokeTarget.id);
                setRevokeTarget(null);
              }}
            >
              {t("admin.invites.revokeConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SettingsCardActions>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={openCreateDialog}
          data-testid="admin-invites-open-create"
        >
          <Plus className="size-4" aria-hidden="true" />
          {t("admin.invites.create")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}

/**
 * "Redeemed by" cell: single redeemer renders inline; multiple open a
 * popover listing every redemption with username, email, and timestamp
 * (the `InviteRedemption` ledger — `usedBy` alone only knows the last).
 */
function RedemptionsCell({
  invite,
  summary,
}: {
  invite: AdminInvite;
  summary: string;
}) {
  const { t } = useTranslations();
  if (invite.redemptions.length === 0) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  if (invite.redemptions.length === 1) {
    const entry = invite.redemptions[0];
    return (
      <div className="leading-tight">
        <div className="text-sm">
          {entry.user?.username ?? t("admin.invites.redeemerDeleted")}
        </div>
        <div className="text-muted-foreground text-xs tabular-nums">
          {formatDateTime(entry.redeemedAt)}
        </div>
      </div>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="hover:text-foreground inline-flex min-h-11 items-center gap-1.5 text-sm underline-offset-4 hover:underline"
          data-testid="admin-invite-redemptions-trigger"
        >
          <Users className="size-3.5" aria-hidden="true" />
          {summary}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <p className="text-sm font-medium">
          {t("admin.invites.redemptionsTitle", {
            count: invite.redemptions.length,
          })}
        </p>
        {/* v1.16.5 — a 50-use invite lists up to 50 signups; cap the
            list height so the popover never outgrows the viewport. */}
        <ul
          className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1"
          data-testid="admin-invite-redemptions-list"
        >
          {invite.redemptions.map((entry) => (
            <li key={entry.id} className="text-sm leading-tight">
              <div>
                {entry.user?.username ?? t("admin.invites.redeemerDeleted")}
                {entry.user?.email && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {entry.user.email}
                  </span>
                )}
              </div>
              <div className="text-muted-foreground text-xs tabular-nums">
                {formatDateTime(entry.redeemedAt)}
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
