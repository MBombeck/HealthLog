"use client";

/**
 * The destructive-control confirmation, in the two shapes the tree needs.
 *
 * The security card's "sign out everywhere" and its per-row revoke, and the
 * same pair on trusted devices, fired on a single tap with no confirmation —
 * while every other destructive surface in the app confirms. Signing every
 * other device out is not recoverable by an undo; the other devices simply
 * have to log in again, and on a shared screen a mis-tap is a support call.
 *
 * Wrapping the pattern rather than inlining a fourth dialog is the point: the
 * next destructive control gets the confirmation by using this, instead of by
 * someone remembering to add one.
 *
 * `ConfirmButton` covers the common case — a button that opens its own dialog.
 * `ConfirmDialog` is the same dialog without the trigger, for the destructive
 * controls that are not buttons: a switch whose off position deletes what it
 * was holding, a menu item, a key binding. Those had no shared path at all,
 * which is a fair part of why they were the ones that shipped unguarded — a
 * control that cannot reach for the primitive reaches for nothing.
 *
 * The copy contract matches the rest of the app after the delete-confirmation
 * sweep — say what happens, and claim no more finality than is true. Callers
 * pass their own body text so each control can be specific about its own
 * consequence.
 */

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useTranslations } from "@/lib/i18n/context";

interface ConfirmCopy {
  title: string;
  body: string;
  /** The dialog's action label. Names the act, not "OK". */
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  /** `data-slot` for tests and the design guards. */
  slot?: string;
  /** A control that belongs with the question, such as an opt-out checkbox. */
  extra?: ReactNode;
  /**
   * The action deletes something: it wears the destructive style, as the
   * data-list selection bar's confirm already does.
   */
  destructive?: boolean;
}

function ConfirmBody({
  title,
  body,
  confirmLabel,
  onConfirm,
  pending = false,
  slot,
  extra,
  destructive = false,
}: ConfirmCopy) {
  const { t } = useTranslations();

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{body}</AlertDialogDescription>
      </AlertDialogHeader>
      {extra}
      <AlertDialogFooter>
        <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
        <AlertDialogAction
          variant={destructive ? "destructive" : "default"}
          data-slot={slot ? `${slot}-confirm` : undefined}
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={onConfirm}
        >
          {pending && (
            <Loader2 className="mr-1 size-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}

export function ConfirmButton({
  label,
  title,
  body,
  confirmLabel,
  onConfirm,
  pending = false,
  disabled = false,
  size,
  variant = "outline",
  className,
  icon,
  ariaLabel,
  slot,
  extra,
}: ConfirmCopy & {
  /** The control's own label, before the dialog opens. */
  label: string;
  disabled?: boolean;
  size?: "sm" | "icon";
  variant?: "outline" | "ghost" | "destructive";
  className?: string;
  /** For an icon-only control, where `label` renders as an icon. */
  ariaLabel?: string;
  icon?: ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          className={className}
          aria-label={ariaLabel}
          data-slot={slot}
          disabled={disabled || pending}
        >
          {pending ? (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          ) : (
            icon
          )}
          {label}
        </Button>
      </AlertDialogTrigger>
      <ConfirmBody
        title={title}
        body={body}
        confirmLabel={confirmLabel}
        onConfirm={onConfirm}
        pending={pending}
        slot={slot}
        extra={extra}
      />
    </AlertDialog>
  );
}

/**
 * The trigger-less half. The caller owns `open` and decides what a dismissal
 * means for its own control — a switch, for instance, has to stay ON when the
 * dialog its OFF position raised is cancelled, which is a state a
 * self-triggering dialog cannot express.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  ...copy
}: ConfirmCopy & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <ConfirmBody {...copy} />
    </AlertDialog>
  );
}
