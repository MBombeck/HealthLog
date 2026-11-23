"use client";

import { forwardRef, useId, useRef } from "react";
import { Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * The one `<input type="file">` in the tree (#1215). A browser draws the
 * native control as a line of text ("Choose File  No file chosen") that does
 * not read as a button, and every engine draws it differently. Every surface
 * that takes a file therefore keeps the native input out of sight and opens
 * it from a control of its own: a `FilePicker` below, a `Button`, a drop zone
 * or a menu item that calls `.click()` on the ref.
 *
 * Without a `className` the input is `sr-only`; a caller that lays the input
 * over its own drop zone passes the classes for that instead.
 *
 * `file-input-single-implementation.test.ts` fails when a raw file input
 * appears anywhere else.
 */
export const FileInput = forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "type">
>(function FileInput({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      type="file"
      className={className ?? "sr-only"}
      {...props}
    />
  );
});

/**
 * A secondary (`outline`) button that opens the file dialog, with the chosen
 * file's name beside it. The button is the only focus stop; the hidden input
 * is taken out of the tab order and the accessibility tree, and the name is
 * the button's description, announced when it changes.
 */
export function FilePicker({
  id,
  accept,
  multiple,
  disabled,
  onChange,
  fileName,
  label,
  className,
  "data-slot": dataSlot,
}: {
  /** Id of the button, for a `Label htmlFor` beside it. */
  id?: string;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  /** The chosen file's name, or null before one is chosen. */
  fileName: string | null;
  /** Button text; defaults to "Choose file". */
  label?: string;
  className?: string;
  "data-slot"?: string;
}) {
  const { t } = useTranslations();
  const inputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}
      data-slot={dataSlot ?? "file-picker"}
    >
      <FileInput
        ref={inputRef}
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        onChange={onChange}
        data-slot="file-picker-input"
      />
      <Button
        id={id}
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 sm:min-h-9"
        disabled={disabled}
        aria-describedby={nameId}
        onClick={() => inputRef.current?.click()}
        data-slot="file-picker-button"
      >
        <Upload className="size-4" aria-hidden="true" />
        {label ?? t("common.filePicker.choose")}
      </Button>
      <span
        id={nameId}
        aria-live="polite"
        className={cn(
          "min-w-0 truncate text-sm",
          fileName ? "text-foreground" : "text-muted-foreground",
        )}
        data-slot="file-picker-name"
      >
        {fileName ?? t("common.filePicker.none")}
      </span>
    </div>
  );
}
