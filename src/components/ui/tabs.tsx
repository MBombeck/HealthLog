"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

// v1.4.16 Wave-C MED — horizontal tab strips overflow viewport on
// mobile when more than ~3 tabs render at typical label widths
// (`/insights`, `/admin`, `/settings/*`). Tab labels are i18n-driven
// so we cannot truncate them deterministically. Instead, the list
// becomes horizontally scrollable on mobile via `overflow-x-auto`
// plus `touch-pan-x` for the iOS PWA, and the wrapping tabs preserve
// `whitespace-nowrap` so labels never word-wrap mid-tab. Desktop
// looks identical because the inline-flex shrink-wraps inside the
// wider container.
//
// v1.4.19 A7 — `overflow-y-hidden` clamps the y-axis. Browsers couple
// the two overflow axes once one is `auto`: setting only
// `overflow-x: auto` silently flips `overflow-y` to `auto` as well.
// Combined with the fixed `h-9` strip and badge children that ride
// ~1 px taller than the strip on some glyph stacks, a tiny painted
// vertical scrollbar appeared on the right edge of short strips
// (e.g. the admin feedback `Open / Acknowledged / Resolved /
// Archived` tabs the maintainer reported in v1.4.19). Locking the y-axis hides
// that bar without affecting horizontal swipe behaviour.
// Padding sits at `p-1` (4 px) so the 3 px focus-visible ring
// (`focus-visible:ring-[3px]`) on triggers stays inside the
// `overflow-y-hidden` clamp without clipping the bottom of the ring.
// Under a coarse pointer the strip sizes to its triggers, which take the
// 44 px touch floor; a mouse keeps the compact 36 px strip.
const tabsListVariants = cva(
  "rounded-lg p-1 group-data-[orientation=horizontal]/tabs:h-9 pointer-coarse:group-data-[orientation=horizontal]/tabs:h-auto data-[variant=line]:rounded-none group/tabs-list text-muted-foreground inline-flex w-fit max-w-full items-center justify-center overflow-x-auto overflow-y-hidden touch-pan-x scrollbar-thin group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col group-data-[orientation=vertical]/tabs:overflow-x-visible group-data-[orientation=vertical]/tabs:overflow-y-visible",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring text-foreground/75 hover:text-foreground dark:text-tab-inactive dark:hover:text-foreground relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
        "data-[state=active]:bg-background dark:data-[state=active]:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 data-[state=active]:text-foreground",
        "after:bg-foreground after:absolute after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
