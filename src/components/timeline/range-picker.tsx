"use client";

/**
 * Choosing a range (v1.42, #613). On a wide screen the "Range" segment of
 * the zoom control opens a popover anchored to it; on a phone the range
 * button opens a sheet. Both hold the two date fields and "Apply", and
 * neither pushes the chart down: the timeline stays where it was until the
 * range is applied, and only then does the URL change (`?zoom=range&from=
 * &to=`), so Back and a bookmark keep working as before.
 *
 * The fields edit a draft. Each change is made honest on the way in
 * (`RangeFields` clamps it), and the draft starts as the range in the URL,
 * or, before there is one, as what the chart shows.
 */
import { useState, type ReactElement } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import type { TimelineZoom } from "@/lib/day/contract";
import { useTranslations } from "@/lib/i18n/context";

import { RangeFields } from "./range-fields";
import { Segmented, type SegmentedOption } from "./segmented";
import type { TimelineRange } from "./timeline-url";

interface RangeLimits {
  today: string;
  /** The record's first entry, once known. */
  dataFrom: string | null;
}

/** The zoom control, with the range popover hung on its "Range" segment. */
export function ZoomControl({
  options,
  zoom,
  label,
  initialRange,
  today,
  dataFrom,
  onZoom,
  onApply,
}: RangeLimits & {
  options: ReadonlyArray<SegmentedOption<TimelineZoom>>;
  zoom: TimelineZoom;
  label: string;
  /** Where the draft starts when the popover opens. */
  initialRange: TimelineRange;
  onZoom: (next: Exclude<TimelineZoom, "range">) => void;
  onApply: (range: TimelineRange) => void;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initialRange);
  const anchor = (value: TimelineZoom, button: ReactElement) =>
    value === "range" ? (
      <PopoverPrimitive.Anchor asChild>{button}</PopoverPrimitive.Anchor>
    ) : (
      button
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Segmented
        options={options}
        value={zoom}
        onChange={(next) => {
          if (next !== "range") {
            setOpen(false);
            onZoom(next);
            return;
          }
          setDraft(initialRange);
          setOpen(true);
        }}
        label={label}
        slot="timeline-zoom"
        wrapOption={anchor}
      />
      <PopoverContent
        align="start"
        className="w-auto max-w-none space-y-4 p-4 text-sm"
        data-slot="timeline-range-popover"
        aria-label={t("timeline.range.open")}
      >
        <p className="font-semibold">{t("timeline.range.open")}</p>
        <RangeFields
          range={draft}
          today={today}
          dataFrom={dataFrom}
          onChange={setDraft}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            className="min-h-11 sm:min-h-9"
            data-slot="timeline-range-apply"
            onClick={() => {
              onApply(draft);
              setOpen(false);
            }}
          >
            {t("timeline.range.apply")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The phone's range sheet: the fields, "Apply", and the way back. */
export function RangeSheet({
  open,
  onOpenChange,
  initialRange,
  today,
  dataFrom,
  onApply,
  onClear,
}: RangeLimits & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialRange: TimelineRange;
  onApply: (range: TimelineRange) => void;
  /** Back to the whole record; offered only while a range is chosen. */
  onClear: (() => void) | null;
}) {
  const { t } = useTranslations();
  const [draft, setDraft] = useState(initialRange);
  // The draft starts over each time the sheet opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(initialRange);
  }
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("timeline.range.open")}
      footer={
        <>
          {onClear && (
            <Button
              variant="outline"
              className="min-h-11"
              data-slot="timeline-range-clear"
              onClick={() => {
                onClear();
                onOpenChange(false);
              }}
            >
              {t("timeline.range.clear")}
            </Button>
          )}
          <Button
            className="min-h-11"
            data-slot="timeline-range-apply"
            onClick={() => {
              onApply(draft);
              onOpenChange(false);
            }}
          >
            {t("timeline.range.apply")}
          </Button>
        </>
      }
    >
      <RangeFields
        range={draft}
        today={today}
        dataFrom={dataFrom}
        onChange={setDraft}
      />
    </ResponsiveSheet>
  );
}
