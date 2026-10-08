"use client";

/**
 * `<ModuleToggleRow>` — one row in the Settings → Module ("Was du trackst")
 * hub. v1.18.0.
 *
 * Renders a single module: a neutral icon, the i18n label + one-line
 * description, and a `<Switch>` reflecting the resolved enabled-state. The
 * row is presentation-only — the parent `<ModulesSection>` owns the mutation
 * and cache invalidation, so this component stays a pure, easily-tested leaf.
 *
 * Every module — including the two delegated ones (coach, cycle) — now
 * renders a real Switch, so the hub reads uniformly. Four shapes ride on top
 * of that Switch:
 *   - toggleable: the Switch is live; flipping it calls `onToggle(next)`.
 *   - delegated (coach, cycle): the Switch is live and drives the canonical
 *     state (coach → `User.disableCoach`; cycle → `cycleTrackingEnabled`),
 *     plus a small `manageLink` deep-link beneath the description points at
 *     the fuller settings surface (Coach cadence, cycle goal/predictions).
 *   - locked (core domains): the Switch is checked + disabled with a short
 *     "always on" note, so the always-on measurement engine reads as
 *     deliberately fixed rather than broken.
 *   - disabled-with-reason: the operator turned the module off server-wide
 *     (or the module is otherwise not applicable). The Switch is disabled and
 *     a `disabledReason` hint renders beneath the description — an honest
 *     "you can't flip this and here's why", never a toggle that no-ops and
 *     snaps back behind a misleading "saved" toast.
 *
 * Palette stays neutral throughout — no alarming green-when-on /
 * red-when-off tint.
 */

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export interface ModuleToggleRowProps {
  /** Stable key — used for the input id + the test query handle. */
  moduleKey: string;
  icon: LucideIcon;
  label: string;
  description: string;
  /** Whether the Switch reads on. Core rows pass `true`. */
  enabled: boolean;
  /**
   * When set the row is read-only: the Switch is locked checked and the
   * `lockedNote` line renders beneath the description. Core domains use this.
   */
  locked?: boolean;
  /** One-line "core / always on" note, only shown when `locked`. */
  lockedNote?: string;
  /**
   * Delegated modules (coach, cycle) keep a small deep-link to the fuller
   * settings surface beside their live Switch — Coach cadence/memory, the
   * cycle goal/prediction/length fields. `label` is the link text; `href`
   * the in-app destination.
   */
  manageLink?: { href: string; label: string };
  /**
   * When set the Switch is disabled and this line renders beneath the
   * description as an honest "why you can't flip this" hint. Used when the
   * operator turned the module off server-wide (a per-user toggle cannot
   * re-enable it) or the module is otherwise not applicable to the account.
   */
  disabledReason?: string;
  /** Disable the Switch while a mutation is in flight (toggleable rows). */
  pending?: boolean;
  /** Fired with the next desired state on a user toggle (toggleable rows). */
  onToggle?: (next: boolean) => void;
}

export function ModuleToggleRow({
  moduleKey,
  icon: Icon,
  label,
  description,
  enabled,
  locked = false,
  lockedNote,
  manageLink,
  disabledReason,
  pending = false,
  onToggle,
}: ModuleToggleRowProps) {
  const inputId = `module-toggle-${moduleKey}`;
  // The Switch is inert when the domain is core (locked), when the operator
  // turned it off / it is inapplicable (disabledReason), or while a mutation
  // is in flight.
  const interactive = !locked && disabledReason == null;
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <Icon
          className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0"
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-0.5">
          {/* A row title beside a switch, not a field label: no colon, and
              on the description's left edge (the primitive's `pl-1` would
              inset it), matching the admin `SettingsToggle` rows. */}
          <Label htmlFor={inputId} noColon className="pl-0 text-sm font-medium">
            {label}
          </Label>
          <p className="text-muted-foreground text-xs">{description}</p>
          {locked && lockedNote ? (
            <p className="text-muted-foreground text-xs">{lockedNote}</p>
          ) : null}
          {disabledReason ? (
            <p className="text-muted-foreground text-xs">{disabledReason}</p>
          ) : null}
          {manageLink ? (
            <Link
              href={manageLink.href}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
            >
              {manageLink.label}
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      </div>
      <Switch
        id={inputId}
        checked={locked ? true : enabled}
        disabled={!interactive || pending}
        onCheckedChange={interactive ? (v) => onToggle?.(v) : undefined}
        className="mt-0.5 shrink-0"
        aria-label={label}
      />
    </div>
  );
}
