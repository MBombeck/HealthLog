"use client";

import { HelpCircle } from "lucide-react";

import { InfoPopover } from "@/components/ui/info-popover";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Small `?` affordance that explains what the adherence percentage
 * actually measures ("share of expected doses you logged — weekly
 * schedules count week by week"). Sits next to the number on the two
 * surfaces that render an adherence rate without context: the
 * dashboard compliance card header and the per-medication bars
 * (`medication-compliance-bars.tsx`).
 *
 * Thin wrapper over `InfoPopover`. This used to be a verbatim structural copy of the primitive; it now
 * only supplies the `HelpCircle` glyph, `align="start"`, and the
 * `compliance-info-*` data-slots the two call sites already key off of.
 */
export function ComplianceInfoTip({ className }: { className?: string }) {
  const { t } = useTranslations();

  return (
    <InfoPopover
      content={t("medications.complianceInfo")}
      label={t("medications.complianceInfoLabel")}
      icon={HelpCircle}
      iconClassName="h-3 w-3"
      align="start"
      triggerDataSlot="compliance-info-trigger"
      bodyDataSlot="compliance-info-body"
      className={className}
    />
  );
}
