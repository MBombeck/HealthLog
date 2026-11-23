"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  Check,
  ChevronDown,
  FileText,
  HeartPulse,
  Share2,
  Smartphone,
  Upload,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { isSurfaceVisible } from "@/lib/modules/surface";
import {
  checklistExtraDismissId,
  visibleChecklistExtras,
  type ChecklistExtraId,
  type ChecklistExtrasDto,
} from "@/lib/onboarding/checklist-extras";
import { queryKeys } from "@/lib/query-keys";

const EXTRA_ICONS: Record<ChecklistExtraId, LucideIcon> = {
  emergencyCard: HeartPulse,
  careFeed: CalendarDays,
  sharing: Share2,
  imports: Upload,
  reportSchedule: FileText,
  iosApp: Smartphone,
};

/**
 * 1.49 — the checklist's optional "More" group.
 *
 * Collapsed by default, and its one presence read
 * (`GET /api/onboarding/extras`) runs only once it is opened, so the dashboard
 * pays nothing for it. Not counted in the checklist's progress: these are
 * offers, not steps. Each row is dismissed like a checklist row, into the same
 * per-browser list. A delegate (somebody else's adult record) gets no group;
 * the server refuses the read there too.
 */
export function GettingStartedExtras({
  dismissed,
  onDismiss,
}: {
  dismissed: ReadonlySet<string>;
  onDismiss: (dismissId: string) => void;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const delegate = user?.accountAccess?.recordKind === "shared";

  const extras = useQuery<ChecklistExtrasDto>({
    queryKey: queryKeys.onboardingExtras(),
    queryFn: () => apiGet<ChecklistExtrasDto>("/api/onboarding/extras"),
    enabled: open && !delegate,
    staleTime: 60_000,
  });

  if (delegate) return null;

  const rows = extras.data
    ? visibleChecklistExtras(extras.data, {
        dismissed,
        surfaceVisible: (id) => isSurfaceVisible(id, user?.modules),
      })
    : [];

  return (
    <div className="space-y-1.5" data-slot="getting-started-extras">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls="getting-started-extras-body"
        className="text-muted-foreground hover:text-foreground flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium transition-colors sm:min-h-10"
        data-slot="getting-started-extras-toggle"
      >
        <ChevronDown
          aria-hidden="true"
          className={
            open
              ? "size-4 shrink-0 transition-transform"
              : "size-4 shrink-0 -rotate-90 transition-transform"
          }
        />
        {t("gettingStarted.extras.toggle")}
      </button>
      {open ? (
        <div id="getting-started-extras-body" className="space-y-1.5">
          <p className="text-muted-foreground px-2 text-xs">
            {t("gettingStarted.extras.hint")}
          </p>
          {extras.isError ? (
            <QueryErrorRow
              inset
              error={extras.error}
              message={t("gettingStarted.extras.loadError")}
              onRetry={() => void extras.refetch()}
            />
          ) : (
            <ul className="space-y-1.5">
              {rows.map((row) => {
                const Icon = EXTRA_ICONS[row.id];
                return (
                  <li
                    key={row.id}
                    data-item-id={`extra:${row.id}`}
                    data-done={row.done}
                    className="hover:bg-accent/40 flex items-center gap-3 rounded-md px-2 py-2"
                  >
                    <span
                      aria-hidden="true"
                      className={
                        row.done
                          ? "bg-primary/20 text-primary flex size-7 shrink-0 items-center justify-center rounded-full"
                          : "bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full"
                      }
                    >
                      {row.done ? (
                        <Check className="size-4" />
                      ) : (
                        <Icon className="size-4" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {t(`gettingStarted.extras.items.${row.id}.title`)}
                      </p>
                      <p className="text-muted-foreground truncate text-xs">
                        {t(`gettingStarted.extras.items.${row.id}.description`)}
                      </p>
                    </div>
                    {!row.done ? (
                      <Button asChild size="sm" variant="outline">
                        {row.external ? (
                          <a href={row.href} target="_blank" rel="noreferrer">
                            {t(`gettingStarted.extras.items.${row.id}.cta`)}
                          </a>
                        ) : (
                          <Link href={row.href}>
                            {t(`gettingStarted.extras.items.${row.id}.cta`)}
                          </Link>
                        )}
                      </Button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onDismiss(checklistExtraDismissId(row.id))}
                      aria-label={t("gettingStarted.dismissTooltip")}
                      className="text-muted-foreground hover:text-foreground inline-flex h-11 w-11 items-center justify-center rounded transition-colors"
                    >
                      <X className="size-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
