"use client";

import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * One choice of several as a single menu button: the chosen option's name and
 * a chevron, opening the options as a menu. The one control of a domain
 * page's summary card (its measure, top right) and of its records heading
 * (the one filter dimension, "Alle Sportarten"). Domain page template, zones
 * 3 and 4: a control never stands as a row of segments or chips.
 *
 * The face is 36 px with a 44 px target under a finger; the label is the
 * chosen option, so the accessible name says what is chosen and `label`
 * says what is being chosen.
 */
export function MenuSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  slot,
  className,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  /** What is being chosen ("Kalender zeigt", "Sportart"). */
  label: string;
  /** `data-slot` of the trigger; each option carries `${slot}-${value}`. */
  slot?: string;
  className?: string;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          data-slot={slot}
          data-value={value}
          aria-label={`${label}: ${current?.label ?? ""}`}
          className={cn(
            "relative h-9 min-w-0 gap-1.5 px-3 font-normal",
            "before:absolute before:-inset-x-0 before:-inset-y-1 before:content-['']",
            className,
          )}
        >
          <span className="truncate">{current?.label}</span>
          <ChevronDown
            className="text-muted-foreground size-4"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as T)}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              data-slot={slot ? `${slot}-${option.value}` : undefined}
              className="pointer-coarse:min-h-11"
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
