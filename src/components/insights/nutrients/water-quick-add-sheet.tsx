"use client";

import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";
import { apiPost } from "@/lib/api/api-fetch";
import { queryKeys, refetchInactiveDailyReads } from "@/lib/query-keys";

/**
 * v1.29 — manual water quick-add sheet, opened from the hydration card.
 *
 * Chips (+200/+300/+500 mL) and custom amounts are one-shot writes:
 * the sheet closes and clears only after the API confirms success. A
 * rejected write leaves the sheet and input untouched so the user can retry.
 *
 * Every write hits `POST /api/nutrients/water`, which owns ONLY the
 * `source="MANUAL"` row (migration 0249) — never the Apple-synced row.
 */

const QUICK_CHIPS_ML = [200, 300, 500] as const;

interface WaterQuickAddSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a confirmed write; bypasses dirty-dismiss guards. */
  onSuccess?: () => void;
  /** Today's combined total. Omit outside the hydration detail surface. */
  todayTotalMl?: number;
}

export function WaterQuickAddSheet({
  open,
  onOpenChange,
  onSuccess,
  todayTotalMl,
}: WaterQuickAddSheetProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [customAmount, setCustomAmount] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [editAmount, setEditAmount] = useState(() =>
    todayTotalMl == null ? "" : String(todayTotalMl),
  );
  const writePendingRef = useRef(false);
  const closeAfterSuccess = onSuccess ?? (() => onOpenChange(false));

  // v1.29.x — the Today digest joins the invalidation. The write route
  // already hard-evicts the server snapshot bucket
  // (`invalidateUserDashboardSnapshot`), but the client digest/snapshot
  // queries are typically unmounted while this sheet is open (the user is
  // on `/insights/nutrients`, not the dashboard), so a default ("active")
  // invalidation would mark them stale without refetching them —
  // `refetchInactiveDailyReads` forces the inactive refetch, mirroring the
  // measurement / mood / medication fix.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.nutrientsRoot() });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.dashboardSnapshot(),
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dailyDigest() });
    void refetchInactiveDailyReads(queryClient);
  };

  const addMutation = useMutation({
    mutationFn: (amountMl: number) =>
      apiPost("/api/nutrients/water", { amountMl, mode: "add" as const }),
    onSuccess: invalidate,
    onError: () => toast.error(t("nutrients.hydration.quickAddError")),
  });

  const setMutation = useMutation({
    mutationFn: (amountMl: number) =>
      apiPost("/api/nutrients/water", { amountMl, mode: "set" as const }),
    onSuccess: () => {
      invalidate();
      setEditMode(false);
    },
    onError: () => toast.error(t("nutrients.hydration.quickAddError")),
  });

  const addWater = async (amount: number) => {
    if (writePendingRef.current) return;
    writePendingRef.current = true;
    try {
      await addMutation.mutateAsync(amount);
      toast.success(
        t("nutrients.hydration.quickAddSuccess", { amount: String(amount) }),
      );
      setCustomAmount("");
      closeAfterSuccess();
    } catch {
      // The mutation owns the translated error toast. Preserve all input.
    } finally {
      writePendingRef.current = false;
    }
  };

  const handleCustomAdd = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amount = Number(customAmount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    void addWater(amount);
  };

  const handleEditSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amount = Number(editAmount);
    if (writePendingRef.current || !Number.isFinite(amount) || amount < 0) {
      return;
    }
    writePendingRef.current = true;
    try {
      await setMutation.mutateAsync(amount);
      toast.success(
        t("nutrients.hydration.quickAddSuccess", { amount: String(amount) }),
      );
      closeAfterSuccess();
    } catch {
      // The mutation owns the translated error toast. Preserve all input.
    } finally {
      writePendingRef.current = false;
    }
  };

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("nutrients.hydration.quickAddTitle")}
    >
      <div className="flex flex-wrap gap-2" data-slot="water-quick-add-chips">
        {QUICK_CHIPS_ML.map((amountMl) => (
          <Button
            key={amountMl}
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={addMutation.isPending || setMutation.isPending}
            onClick={() => void addWater(amountMl)}
          >
            +{amountMl} mL
          </Button>
        ))}
      </div>

      <form className="flex items-end gap-2" onSubmit={handleCustomAdd}>
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="water-custom-amount">
            {t("nutrients.hydration.quickAddCustomLabel")}
          </Label>
          <Input
            id="water-custom-amount"
            name="amountMl"
            type="number"
            inputMode="numeric"
            min={1}
            max={20000}
            placeholder={t("nutrients.hydration.quickAddCustomPlaceholder")}
            value={customAmount}
            onChange={(e) => setCustomAmount(e.target.value)}
          />
        </div>
        <Button
          type="submit"
          className="min-h-11 sm:min-h-9"
          disabled={
            addMutation.isPending || setMutation.isPending || !customAmount
          }
        >
          {t("nutrients.hydration.quickAddSubmit")}
        </Button>
      </form>

      {todayTotalMl != null && editMode ? (
        <form
          className="border-border/70 space-y-1.5 border-t pt-4"
          onSubmit={handleEditSave}
        >
          <Label htmlFor="water-edit-total">
            {t("nutrients.hydration.editTotal")}
          </Label>
          <div className="flex items-end gap-2">
            <Input
              id="water-edit-total"
              name="totalMl"
              type="number"
              inputMode="numeric"
              min={0}
              max={20000}
              className="flex-1"
              value={editAmount}
              onChange={(e) => setEditAmount(e.target.value)}
            />
            <Button
              type="submit"
              className="min-h-11 sm:min-h-9"
              disabled={addMutation.isPending || setMutation.isPending}
            >
              {t("nutrients.hydration.quickAddSubmit")}
            </Button>
          </div>
        </form>
      ) : todayTotalMl != null ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground min-h-11 self-start sm:min-h-8"
          onClick={() => {
            setEditAmount(String(todayTotalMl));
            setEditMode(true);
          }}
        >
          {t("nutrients.hydration.editTotal")}
        </Button>
      ) : null}
    </ResponsiveSheet>
  );
}
