import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { SettingsCardActions } from "../_card-actions";

/** What every managed-record family form receives from the section. */
export type SettingsFormProps = {
  settings: Record<string, unknown>;
  disabled: boolean;
  onSave: (patch: unknown) => void;
  saveLabel: string;
  /** Save/validation error, rendered ABOVE the action row per §12. */
  error?: ReactNode;
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function formNumber(
  form: FormData,
  name: string,
  fallback: number,
): number {
  const value = Number(form.get(name));
  return Number.isFinite(value) ? value : fallback;
}

export function ownStringValue(
  inventory: object,
  id: string,
): string | undefined {
  if (!Object.hasOwn(inventory, id)) return undefined;
  const value = Reflect.get(inventory, id);
  return typeof value === "string" ? value : undefined;
}

/**
 * The form footer, §12: the error line sits ABOVE the action row, and the
 * action row (`SettingsCardActions`) is the last thing in the form. `span`
 * lets a grid form put the footer in a full-width cell.
 */
export function FormFooter({
  disabled,
  label,
  error,
  span,
}: {
  disabled: boolean;
  label: string;
  error?: ReactNode;
  span?: string;
}) {
  return (
    <div className={span ? `${span} space-y-3` : "space-y-3"}>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <SettingsCardActions>
        <Button disabled={disabled} type="submit">
          {label}
        </Button>
      </SettingsCardActions>
    </div>
  );
}

/**
 * A managed-settings toggle row — a `<Switch>` (the same primitive the owner
 * module section uses) paired with a hidden mirror input so the FormData
 * submit still reads `name === "on"`. Uncontrolled at the DOM level, controlled
 * in React so the switch and its mirror stay in lockstep.
 */
export function ManagedSwitchRow({
  name,
  label,
  defaultChecked,
  disabled,
  className,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
  disabled: boolean;
  className?: string;
}) {
  const id = `managed-switch-${name}`;
  const [on, setOn] = useState(defaultChecked);
  return (
    <div
      className={className ?? "flex items-center justify-between gap-3 text-sm"}
    >
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      <Switch
        id={id}
        checked={on}
        onCheckedChange={setOn}
        disabled={disabled}
        aria-label={label}
        className="shrink-0"
      />
      <input name={name} type="hidden" value={on ? "on" : "off"} />
    </div>
  );
}
