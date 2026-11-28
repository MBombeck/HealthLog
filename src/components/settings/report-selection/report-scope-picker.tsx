"use client";

/**
 * The one scope picker. Both surfaces that choose what a report contains — the
 * export panel and the share-link create form — mount this exact component, so
 * two selection UIs cannot drift apart.
 *
 * Nothing is ever selected for the user. A picker with an empty selection
 * stays empty until someone ticks something, and the one shipped template is
 * reachable only through the button at the top that carries its name. One
 * click still gets a complete doctor's report, so nothing got slower — but the
 * click happened, and that is the whole difference between a chosen scope and
 * a scope somebody merely failed to untick.
 *
 * Twelve group rows plus a fenced tier below a separator. The fenced tier has
 * NO group checkbox: there is no control anywhere in this component that can
 * turn on more than one sensitive leaf at a time, and there is no select-all.
 * The fence uses no colour to mark itself — a separator, a heading, and
 * per-leaf controls. A red tint would be decoration; status colour is reserved
 * for meaning.
 *
 * The component is controlled: it owns no selection state, only which rows are
 * expanded and what each group looked like before it was switched off.
 *
 * `surface` is required because Settings → Gesundheitsakte mounts the picker
 * twice on one page. Every test id under the picker ends with it, so each mount
 * stays uniquely addressable no matter how many surfaces adopt the component.
 */
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useTranslations } from "@/lib/i18n/context";
import {
  REPORT_GROUPS,
  SENSITIVE_GROUP_ID,
  type ReportGroupId,
  type ReportLeafId,
} from "@/lib/report-selection/catalogue";
import {
  groupCheckState,
  groupCount,
  toggleGroup,
  toggleLeaf,
} from "@/lib/report-selection/panel-state";
import {
  STANDARD_TEMPLATE_LABEL_KEY,
  standardTemplateFor,
} from "@/lib/report-selection/template";

import { GroupRow } from "./group-row";
import { LeafGrid } from "./leaf-grid";
import type { ReportScopeSurface } from "./surface";

export function ReportScopePicker({
  surface,
  selected,
  onChange,
  hiddenLeaves,
}: {
  /**
   * The mount this picker belongs to. Names every test id under it, so the two
   * pickers that share the Gesundheitsakte page never collide.
   */
  surface: ReportScopeSurface;
  selected: ReadonlySet<ReportLeafId>;
  onChange: (next: Set<ReportLeafId>) => void;
  /**
   * Leaves this surface must not offer at all. The share-link form passes the
   * insurance leaf: the server refuses it with a 422, and a control that
   * cannot be honoured has no business rendering.
   */
  hiddenLeaves?: readonly ReportLeafId[];
}) {
  const { t } = useTranslations();
  const idPrefix = useId();
  const [openGroups, setOpenGroups] = useState<ReadonlySet<ReportGroupId>>(
    new Set(),
  );
  // What each group looked like before it was switched off, so switching it
  // back on inside one session restores the pattern instead of flooding it.
  const [remembered, setRemembered] = useState<ReadonlySet<ReportLeafId>>(
    new Set(),
  );

  const hidden = new Set(hiddenLeaves ?? []);
  const groups = REPORT_GROUPS.map((group) => ({
    ...group,
    leaves: group.leaves.filter((leaf) => !hidden.has(leaf)),
  })).filter((group) => group.leaves.length > 0);

  const plainGroups = groups.filter((g) => g.id !== SENSITIVE_GROUP_ID);
  const sensitiveGroup = groups.find((g) => g.id === SENSITIVE_GROUP_ID);

  const handleLeaf = (leaf: ReportLeafId) => {
    setRemembered(new Set(selected));
    onChange(toggleLeaf(selected, leaf));
  };

  const handleGroup = (
    group: ReportGroupId,
    leaves: readonly ReportLeafId[],
  ) => {
    setRemembered(new Set(selected));
    onChange(toggleGroup(selected, group, leaves, remembered));
  };

  const hintId = `${idPrefix}-standard`;

  return (
    <div className="space-y-3" data-testid={`report-scope-picker-${surface}`}>
      {/* The one-click way to a complete report. An inline action row
          (ui-standards.md §11): the sentence wraps, the action stays beside it.
          It is offered, never applied — and it stays offered so a person can
          come back to the standard set after experimenting. On a phone the
          action's own label is wider than half the row, so beside it the
          sentence shrank to a one-word column and the button ran past the
          card edge: there the action drops under the sentence instead. */}
      <div className="flex items-start justify-between gap-3 max-sm:flex-col">
        <p
          id={hintId}
          className="text-muted-foreground min-w-0 flex-1 text-xs"
          data-testid={`report-standard-hint-${surface}`}
        >
          {t("reportSelection.standardHint")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 shrink-0 sm:min-h-9"
          aria-describedby={hintId}
          data-testid={`report-apply-standard-${surface}`}
          onClick={() => onChange(new Set(standardTemplateFor(hiddenLeaves)))}
        >
          {t("reportSelection.applyStandard", {
            template: t(STANDARD_TEMPLATE_LABEL_KEY),
          })}
        </Button>
      </div>

      {plainGroups.map((group) => (
        <GroupRow
          key={group.id}
          t={t}
          surface={surface}
          id={group.id}
          labelKey={group.labelKey}
          leaves={group.leaves}
          selected={selected}
          checkState={groupCheckState(group.leaves, selected)}
          count={groupCount(group.leaves, selected)}
          open={openGroups.has(group.id)}
          panelId={`${idPrefix}-${group.id}`}
          onToggleGroup={() => handleGroup(group.id, group.leaves)}
          onToggleLeaf={handleLeaf}
          onToggleOpen={() =>
            setOpenGroups((prev) => {
              const next = new Set(prev);
              if (next.has(group.id)) next.delete(group.id);
              else next.add(group.id);
              return next;
            })
          }
        />
      ))}

      {sensitiveGroup ? (
        <div data-testid={`report-sensitive-tier-${surface}`}>
          <Separator className="my-4" />
          <p className="text-muted-foreground mb-2 text-xs font-medium">
            {t(sensitiveGroup.labelKey)}
          </p>
          <p className="text-muted-foreground mb-2 text-xs">
            {t("reportSelection.sensitiveHint")}
          </p>
          <LeafGrid
            t={t}
            surface={surface}
            leaves={sensitiveGroup.leaves}
            selected={selected}
            onToggle={handleLeaf}
          />
        </div>
      ) : null}
    </div>
  );
}
