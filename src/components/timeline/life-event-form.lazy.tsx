"use client";

/**
 * The life-event form, loaded when the capture picker first opens it
 * (v1.42, #613). The picker sits in the shell of every authenticated page;
 * this keeps the form and the timeline's date helpers out of that bundle.
 * Same arrangement as the quick-entry forms.
 */
import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";

function FormSkeleton() {
  return (
    <div className="space-y-4" data-slot="life-event-form-loading">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-2/3" />
    </div>
  );
}

export const LifeEventForm = dynamic(
  () => import("./life-event-form").then((m) => ({ default: m.LifeEventForm })),
  { ssr: false, loading: FormSkeleton },
);
