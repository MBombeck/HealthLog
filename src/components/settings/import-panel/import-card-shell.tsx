import type { LucideIcon } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { QueryErrorRow } from "@/components/ui/query-error-row";

export interface ImportCardShellProps {
  testId: string;
  /** Deep-link anchor for the card (`/settings/export#<anchor>`). */
  anchor: string;
  icon: LucideIcon;
  title: string;
  description: string;
  children: React.ReactNode;
}

export function ImportCardShell({
  testId,
  anchor,
  icon: Icon,
  title,
  description,
  children,
}: ImportCardShellProps) {
  return (
    <SettingsCard data-testid={testId} className="flex h-full flex-col">
      <SettingsCardHeader
        anchor={anchor}
        icon={Icon}
        title={title}
        description={description}
      />
      <div className="flex flex-1 flex-col gap-3">{children}</div>
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
