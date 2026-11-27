"use client";

import type { LucideIcon } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Disclosure } from "@/components/ui/disclosure";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useTranslations } from "@/lib/i18n/context";

export interface ImportCardShellProps {
  testId: string;
  /** Deep-link anchor for the card (`/settings/export#<anchor>`). */
  anchor: string;
  icon: LucideIcon;
  title: string;
  description: string;
  /** The label the folded body opens under; "Import" by default. */
  foldLabel?: string;
  children: React.ReactNode;
}

export function ImportCardShell({
  testId,
  anchor,
  icon: Icon,
  title,
  description,
  foldLabel,
  children,
}: ImportCardShellProps) {
  const { t } = useTranslations();
  return (
    <SettingsCard data-testid={testId} className="flex h-full flex-col">
      <SettingsCardHeader
        anchor={anchor}
        icon={Icon}
        title={title}
        description={description}
      />
      {/* The steps, the drop zone and the result stay folded until the card
          is opened: a list of a dozen sources read as a dozen manuals. */}
      <Disclosure data-fold framed summary={foldLabel ?? t("common.import")}>
        <div className="flex flex-1 flex-col gap-3">{children}</div>
      </Disclosure>
    </SettingsCard>
  );
}

/**
 * The live region a file import card reports its progress and outcome in,
 * announced to assistive tech. When the last import's status could not be
 * read it says so first, with Retry, rather than looking like nothing ever
 * ran; uploading stays possible (the server refuses a second run itself).
 */
export function ImportStatusRegion({
  query,
  children,
}: {
  query: { isError: boolean; error: unknown; refetch: () => unknown };
  children: React.ReactNode;
}) {
  return (
    <div aria-live="polite" className="space-y-2">
      {query.isError && (
        <QueryErrorRow
          inset
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {children}
    </div>
  );
}
