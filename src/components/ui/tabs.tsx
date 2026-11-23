"use client";

import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * The root takes `min-w-0`. The strip below scrolls when its labels outgrow
 * the width, but a scroll container still reports its whole content as its
 * min-content width, so a root standing in a grid or flex cell (the Cycle
 * page's single phone column) widened that cell to the strip's labels and
 * pushed the page sideways instead of letting the strip scroll.
 */
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
        "group/tabs flex min-w-0 gap-2 data-[orientation=horizontal]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Views inside one page, each with a panel: the segmented control's look
 * (`ui/segmented.tsx`), with Radix tabs under it. No track, the chosen tab
 * filled in the primary colour, the others plain until hovered.
 *
 * It used to be a muted track with a raised segment, the look `Segmented`
 * tried and dropped as heavier than the card around it. Four pages kept it
 * through this primitive, so "another view of this page" looked one way on
 * Cycle and Checkups and another everywhere else.
 *
 * The strip scrolls sideways when its labels outgrow the width (they are
 * translated, so they cannot be cut), and never wraps a label.
 * `overflow-x-auto` clips vertically too, so `overflow-y-hidden` is stated
 * (a strip a pixel taller than its content painted a tiny scrollbar) and
 * `px-1 py-1` keeps the focus ring inside the clip box, with `-mx-1 -my-1`
 * giving that room back to the layout. No `touch-action`: the overflow
 * already pans the strip sideways, and `touch-pan-x` also refused the
 * vertical pan, so a swipe that began on a strip scrolled nothing.
 */
function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "-mx-1 -my-1 inline-flex w-fit max-w-full scrollbar-thin items-center gap-1 overflow-x-auto overflow-y-hidden px-1 py-1 group-data-[orientation=vertical]/tabs:flex-col group-data-[orientation=vertical]/tabs:items-stretch group-data-[orientation=vertical]/tabs:overflow-visible",
        className,
      )}
      {...props}
    />
  );
}

/**
 * One tab: 36 px under a mouse, 44 px under a finger, like a segment. The
 * chosen state is spelled under `data-[state=active]`, with the hover and
 * dark-theme forms named too, so it outranks the rest state in every case.
 */
function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "focus-visible:ring-ring/50 inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none group-data-[orientation=vertical]/tabs:justify-start focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "text-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        "data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:hover:bg-primary/90 data-[state=active]:hover:text-primary-foreground dark:data-[state=active]:hover:bg-primary/90",
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

export { Tabs, TabsList, TabsTrigger, TabsContent };
