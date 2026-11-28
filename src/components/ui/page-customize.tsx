"use client";

import * as React from "react";
import { ArrowLeft, Plus, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ListGroup } from "@/components/ui/list-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * "Seite anpassen": the one home of a domain page's settings
 * (`domain-page-template.md` section 6). The wrench sits in the header, in
 * the same place on every domain page, and opens one sheet: a bottom sheet
 * on a phone, a dialog on a wide screen.
 *
 * The sheet holds up to four groups, always in this order and absent when
 * empty: Anzeige, Erfassung, Erinnerungen, Daten. Every row is a
 * `ListItem` with a switch, or its current value (`RowValue`) and a
 * chevron; a row that needs a form opens it as a second level of the same
 * sheet (`level`), with a back arrow and its own footer pair. No save
 * button: a switch acts at once.
 */

export type PageCustomizeGroupKey =
  "display" | "capture" | "reminders" | "data";

/** The wrench in a domain page's header. */
export function PageCustomizeButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslations();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-slot="page-customize"
      aria-label={t("pageCustomize.title")}
      title={t("pageCustomize.title")}
      onClick={onClick}
      className={cn(
        "text-muted-foreground hover:text-foreground relative size-10",
        "before:absolute before:-inset-1.5 before:content-['']",
      )}
    >
      <Wrench className="size-5" aria-hidden="true" />
    </Button>
  );
}

/**
 * The page's add action on a wide screen: the filled "Hinzufügen", last in
 * the header. A phone has none in the header; the tab bar's plus opens the
 * domain's form there (`captureKindForPath`).
 */
export function PageAddButton({
  onClick,
  label,
  slot = "page-add",
}: {
  onClick: () => void;
  /** Accessible name when "Hinzufügen" alone does not say what is added. */
  label?: string;
  slot?: string;
}) {
  const { t } = useTranslations();
  return (
    <Button
      type="button"
      data-slot={slot}
      aria-label={label}
      onClick={onClick}
      className="shell-mobile:hidden"
    >
      <Plus className="size-4" aria-hidden="true" />
      {t("common.add")}
    </Button>
  );
}

/** One group of the sheet: its name above one card of rows. */
export function PageCustomizeGroup({
  group,
  children,
}: {
  group: PageCustomizeGroupKey;
  children: React.ReactNode;
}) {
  const { t } = useTranslations();
  const id = React.useId();
  return (
    <section
      data-slot="page-customize-group"
      data-group={group}
      aria-labelledby={id}
      className="space-y-2"
    >
      <h3 id={id} className="text-muted-foreground px-1 text-sm">
        {t(`pageCustomize.group.${group}`)}
      </h3>
      <ListGroup>{children}</ListGroup>
    </section>
  );
}

/** A second level of the sheet: a row's editor, with a back arrow. */
export interface PageCustomizeLevel {
  title: string;
  body: React.ReactNode;
  /** The editor's own footer pair. */
  footer?: React.ReactNode;
}

export function PageCustomizeSheet({
  open,
  onOpenChange,
  level,
  onBack,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The open second level, or null for the groups. */
  level?: PageCustomizeLevel | null;
  onBack?: () => void;
  /** The groups (`PageCustomizeGroup`), in the order above. */
  children: React.ReactNode;
}) {
  const { t } = useTranslations();
  const title = level ? (
    <span className="flex min-w-0 items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-slot="page-customize-back"
        aria-label={t("pageCustomize.back")}
        onClick={onBack}
        className="-ml-2"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
      </Button>
      <span className="truncate">{level.title}</span>
    </span>
  ) : (
    t("pageCustomize.title")
  );
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={level?.footer}
    >
      <div
        data-slot="page-customize-sheet"
        data-level={level ? "2" : "1"}
        className="space-y-6"
      >
        {level ? level.body : children}
      </div>
    </ResponsiveSheet>
  );
}
