"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { MedicationInventoryState } from "@/generated/prisma/client";
import {
  DEFAULT_IN_USE_WINDOW_DAYS,
  daysRemainingInUse,
} from "@/lib/medications/inventory/state-machine";

/**
 * v1.4.25 W19b — Inventory disclosure for the GLP-1 medication card.
 *
 * Sits inline in the GLP-1 card as a collapsible section. Shows the
 * active and recently-used pens, surfaces the 30-day in-use clock per
 * pen, and offers an "Add new pen" dialog for `purchasedAt` +
 * `printedExpiry` + `dosesTotal`. Per-pen actions are
 * mark-as-in-use (manual override when an intake didn't auto-flip
 * the state) and mark-as-used-up (terminal override when a pen is
 * physically discarded).
 *
 * The UI deliberately reuses existing primitives — Card, Dialog,
 * Input, Badge, Button — no new shadcn block.
 *
 * v1.4.25 W21 Fix-N
 *   - The local `InventoryState` string-union has been dropped in
 *     favour of the canonical `MedicationInventoryState` enum from
 *     the Prisma client.
 *   - The reimplemented client-side `daysRemainingInUse` has been
 *     replaced by the widened pure helper from the inventory
 *     state-machine module; one rule for the deadline math.
 */

interface InventoryItem {
  id: string;
  state: MedicationInventoryState;
  dosesTotal: number;
  dosesRemaining: number;
  firstUseAt: string | null;
  expiresAt: string | null;
  printedExpiry: string | null;
  purchasedAt: string | null;
  notes: string | null;
  createdAt: string;
}

interface InventorySectionProps {
  medicationId: string;
  /** Doses per pen — passed in so the dialog can pre-fill the input
   *  with the knowledge-layer value (e.g. 4 for a Mounjaro KwikPen). */
  defaultDosesPerUnit: number | null;
}

export function InventorySection({
  medicationId,
  defaultDosesPerUnit,
}: InventorySectionProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [dosesTotal, setDosesTotal] = useState<string>(
    defaultDosesPerUnit ? String(defaultDosesPerUnit) : "",
  );
  const [printedExpiry, setPrintedExpiry] = useState<string>("");
  const [purchasedAt, setPurchasedAt] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [formError, setFormError] = useState<string | null>(null);

  const listKey = ["medications", medicationId, "inventory"] as const;

  const { data, isLoading } = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const res = await fetch(
        `/api/medications/${medicationId}/inventory`,
      );
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data: { items: InventoryItem[]; meta: { total: number } };
      };
      return json.data;
    },
    staleTime: 60 * 1000,
    enabled: open,
  });

  const createMutation = useMutation({
    mutationFn: async (payload: {
      dosesTotal: number;
      printedExpiry: string | null;
      purchasedAt: string | null;
      notes: string | null;
    }) => {
      const res = await fetch(
        `/api/medications/${medicationId}/inventory`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "Failed to add pen");
      }
      return (await res.json()).data as InventoryItem;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
  });

  const patchMutation = useMutation({
    mutationFn: async (vars: {
      itemId: string;
      body: Record<string, unknown>;
    }) => {
      const res = await fetch(
        `/api/medications/${medicationId}/inventory/${vars.itemId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(vars.body),
        },
      );
      if (!res.ok) throw new Error("Failed to update pen");
      return (await res.json()).data as InventoryItem;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (itemId: string) => {
      const res = await fetch(
        `/api/medications/${medicationId}/inventory/${itemId}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Failed to delete pen");
      return true;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
  });

  function resetAddForm() {
    setDosesTotal(defaultDosesPerUnit ? String(defaultDosesPerUnit) : "");
    setPrintedExpiry("");
    setPurchasedAt("");
    setNotes("");
    setFormError(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const dt = Number(dosesTotal);
    if (!Number.isInteger(dt) || dt < 1 || dt > 100) {
      setFormError(t("medications.inventory.errorDosesTotal"));
      return;
    }
    createMutation.mutate(
      {
        dosesTotal: dt,
        printedExpiry: printedExpiry ? new Date(printedExpiry).toISOString() : null,
        purchasedAt: purchasedAt ? new Date(purchasedAt).toISOString() : null,
        notes: notes.trim() ? notes.trim() : null,
      },
      {
        onSuccess: () => {
          resetAddForm();
          setAddOpen(false);
        },
        onError: (err) => {
          setFormError(err instanceof Error ? err.message : String(err));
        },
      },
    );
  }

  const items = data?.items ?? [];
  const liveItems = items.filter(
    (i) => i.state === "ACTIVE" || i.state === "IN_USE",
  );
  const pastItems = items.filter(
    (i) => i.state === "EXPIRED" || i.state === "USED_UP",
  );

  // Snapshot "now" once per render. The disclosure is opt-in (the
  // user clicks to expand), so re-rendering on focus events should
  // not cause the "days remaining" labels to flicker between values.
  // eslint-disable-next-line react-hooks/purity -- intentional one-shot snapshot
  const nowMs = useMemo(() => Date.now(), []);

  function stateLabel(item: InventoryItem): string {
    if (item.state === "ACTIVE") {
      return t("medications.inventory.state.active");
    }
    if (item.state === "IN_USE") {
      const d = daysRemainingInUse(
        { firstUseAt: item.firstUseAt },
        nowMs,
        DEFAULT_IN_USE_WINDOW_DAYS,
      );
      return t("medications.inventory.state.inUse", { days: d ?? 0 });
    }
    if (item.state === "EXPIRED") {
      return t("medications.inventory.state.expired");
    }
    return t("medications.inventory.state.usedUp");
  }

  function badgeVariant(
    state: MedicationInventoryState,
  ): "default" | "outline" | "secondary" | "destructive" {
    if (state === "EXPIRED") return "destructive";
    if (state === "USED_UP") return "secondary";
    if (state === "IN_USE") return "default";
    return "outline";
  }

  return (
    <>
      <details
        className="border-border/60 rounded-md border text-xs"
        open={open}
        onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="text-foreground/85 flex cursor-pointer list-none items-center justify-between px-3 py-2 font-medium">
          <span>
            {t("medications.inventory.title")}
            {liveItems.length > 0 && (
              <span className="text-muted-foreground ml-1.5 font-normal">
                ({liveItems.length})
              </span>
            )}
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </summary>
        <div className="border-border/60 space-y-3 border-t px-3 py-2.5">
          {isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{t("medications.inventory.loading")}</span>
            </div>
          )}

          {!isLoading && liveItems.length === 0 && pastItems.length === 0 && (
            <p className="text-muted-foreground">
              {t("medications.inventory.empty")}
            </p>
          )}

          {liveItems.length > 0 && (
            <ul className="space-y-2">
              {liveItems.map((item) => (
                <li
                  key={item.id}
                  className="bg-muted/30 flex items-start justify-between gap-2 rounded-md px-2.5 py-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant={badgeVariant(item.state)}
                        className="text-[10px]"
                      >
                        {stateLabel(item)}
                      </Badge>
                      <span className="text-foreground/85 font-medium tabular-nums">
                        {item.dosesRemaining}/{item.dosesTotal}{" "}
                        {t("medications.inventory.dosesLabel")}
                      </span>
                    </div>
                    {item.printedExpiry && (
                      <p className="text-muted-foreground">
                        {t("medications.inventory.printedExpiry", {
                          date: fmt.dateShort(new Date(item.printedExpiry)),
                        })}
                      </p>
                    )}
                    {item.purchasedAt && (
                      <p className="text-muted-foreground">
                        {t("medications.inventory.purchasedAt", {
                          date: fmt.dateShort(new Date(item.purchasedAt)),
                        })}
                      </p>
                    )}
                    {item.notes && (
                      <p className="text-muted-foreground italic">
                        {item.notes}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    {item.state === "ACTIVE" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[10px]"
                        onClick={() =>
                          patchMutation.mutate({
                            itemId: item.id,
                            body: { markAsFirstUseAt: new Date().toISOString() },
                          })
                        }
                        disabled={patchMutation.isPending}
                      >
                        {t("medications.inventory.markAsInUse")}
                      </Button>
                    )}
                    {(item.state === "ACTIVE" || item.state === "IN_USE") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[10px]"
                        onClick={() =>
                          patchMutation.mutate({
                            itemId: item.id,
                            body: { markAsUsedUp: true },
                          })
                        }
                        disabled={patchMutation.isPending}
                      >
                        {t("medications.inventory.markAsUsedUp")}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {pastItems.length > 0 && (
            <details className="border-border/40 rounded-md border">
              <summary className="text-muted-foreground cursor-pointer list-none px-2.5 py-1.5 font-medium">
                {t("medications.inventory.pastTitle", {
                  count: pastItems.length,
                })}
              </summary>
              <ul className="border-border/40 space-y-1 border-t px-2.5 py-2">
                {pastItems.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant={badgeVariant(item.state)}
                        className="text-[10px]"
                      >
                        {stateLabel(item)}
                      </Badge>
                      <span className="text-muted-foreground tabular-nums">
                        {item.dosesRemaining}/{item.dosesTotal}
                      </span>
                      {item.firstUseAt && (
                        <span className="text-muted-foreground">
                          ·{" "}
                          {fmt.dateShort(new Date(item.firstUseAt))}
                        </span>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={() => deleteMutation.mutate(item.id)}
                      disabled={deleteMutation.isPending}
                      aria-label={t("medications.inventory.delete")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("medications.inventory.addPen")}
          </Button>
        </div>
      </details>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("medications.inventory.addPenTitle")}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="inv-doses-total">
                {t("medications.inventory.fieldDosesTotal")}
              </Label>
              <Input
                id="inv-doses-total"
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                step={1}
                value={dosesTotal}
                onChange={(e) => setDosesTotal(e.target.value)}
                required
              />
              <p className="text-muted-foreground text-xs">
                {t("medications.inventory.fieldDosesTotalHelp")}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="inv-printed-expiry">
                {t("medications.inventory.fieldPrintedExpiry")}
              </Label>
              <Input
                id="inv-printed-expiry"
                type="date"
                value={printedExpiry}
                onChange={(e) => setPrintedExpiry(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="inv-purchased-at">
                {t("medications.inventory.fieldPurchasedAt")}
              </Label>
              <Input
                id="inv-purchased-at"
                type="date"
                value={purchasedAt}
                onChange={(e) => setPurchasedAt(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="inv-notes">
                {t("medications.inventory.fieldNotes")}
              </Label>
              <textarea
                id="inv-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={200}
                rows={2}
                className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            {formError && (
              <p className="text-destructive text-sm">{formError}</p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  resetAddForm();
                  setAddOpen(false);
                }}
              >
                {t("medications.inventory.cancel")}
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                )}
                {t("medications.inventory.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
