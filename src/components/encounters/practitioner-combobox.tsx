"use client";

/**
 * The practice picker on the visit form.
 *
 * A combobox rather than a select, because the address book grows past the
 * length a dropdown reads well at and a person types the first three letters
 * of a practice name faster than they scroll to it. The search runs in SQL over
 * the two plaintext columns — that is why they are plaintext.
 *
 * "Add new" opens a nested sheet rather than navigating away. A person filling
 * a half-finished visit form who is sent to another page to add a doctor comes
 * back to an empty form, so the affordance that looks helpful is the one that
 * loses their work.
 *
 * The field is OPTIONAL and says so: a person can log "the emergency room on
 * the 3rd" before they know whose name was on the door.
 */
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { usePractitioners, type Practitioner } from "@/hooks/use-practitioners";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { PractitionerSheet } from "@/components/practitioners/practitioner-sheet";

export function PractitionerCombobox({
  value,
  onChange,
  /** The already-resolved entry, so the closed trigger names it without a read. */
  selected,
  disabled,
}: {
  value: string | null;
  onChange: (next: Practitioner | null) => void;
  selected: Practitioner | null;
  disabled?: boolean;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [adding, setAdding] = useState(false);
  // Bumped on each open so the nested sheet remounts empty rather than showing
  // whatever the last attempt left in it.
  const [session, setSession] = useState(0);
  const debounced = useDebouncedValue(term, 250);

  const list = usePractitioners(debounced, open);
  const rows = list.data ?? [];

  return (
    <>
      <div className="flex items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              // `role="combobox"` is not a name-from-content role: the visible
              // placeholder span does not give the trigger an accessible name,
              // so name it from the field's own label. Applies wherever this
              // combobox is embedded (the visit form and the immunization form).
              aria-label={t("encounters.form.practitioner")}
              disabled={disabled}
              data-slot="encounter-practitioner-trigger"
              className="min-h-11 min-w-0 flex-1 justify-between font-normal"
            >
              <span
                className={cn(
                  "truncate",
                  selected ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {selected?.name ?? t("encounters.form.practitionerNone")}
              </span>
              <ChevronsUpDown
                className="size-4 shrink-0 opacity-50"
                aria-hidden
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-(--radix-popover-trigger-width) max-w-none p-2">
            <Input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder={t("encounters.form.practitionerSearch")}
              aria-label={t("encounters.form.practitionerSearch")}
              data-slot="encounter-practitioner-search"
            />
            <div className="mt-2 max-h-56 space-y-1 overflow-y-auto overscroll-contain">
              {list.isPending ? (
                <Skeleton className="h-9 w-full rounded-md" />
              ) : rows.length === 0 ? (
                <p className="text-muted-foreground px-2 py-3 text-sm">
                  {t("encounters.form.practitionerNoMatch")}
                </p>
              ) : (
                rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    data-slot="encounter-practitioner-option"
                    onClick={() => {
                      onChange(row);
                      setOpen(false);
                    }}
                    className="hover:bg-muted/60 flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm"
                  >
                    <Check
                      className={cn(
                        "size-4 shrink-0",
                        row.id === value ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate">
                        {row.name}
                      </span>
                      {row.practice || row.specialty ? (
                        <span className="text-muted-foreground block truncate text-xs">
                          {[row.practice, row.specialty]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 min-h-11 w-full"
              onClick={() => {
                setOpen(false);
                setAdding(true);
                setSession((n) => n + 1);
              }}
            >
              <Plus className="size-4" aria-hidden />
              {t("encounters.form.practitionerAdd")}
            </Button>
          </PopoverContent>
        </Popover>

        {selected ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label={t("encounters.form.practitionerClear")}
            onClick={() => onChange(null)}
          >
            <X className="size-4" aria-hidden />
          </Button>
        ) : null}
      </div>

      {/* Nested, so the half-filled visit form behind it stays mounted. */}
      <PractitionerSheet
        key={session}
        open={adding}
        onOpenChange={setAdding}
        practitioner={null}
        onSaved={(created) => onChange(created)}
      />
    </>
  );
}
