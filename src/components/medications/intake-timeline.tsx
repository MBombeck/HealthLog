"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Check, SkipForward, Loader2 } from "lucide-react";

interface IntakeEvent {
  id: string;
  medicationId: string;
  scheduledFor: string;
  takenAt: string | null;
  skipped: boolean;
  source: string;
  createdAt: string;
}

interface IntakeTimelineProps {
  medicationId: string;
  medicationName: string;
}

export function IntakeTimeline({
  medicationId,
  medicationName,
}: IntakeTimelineProps) {
  const { data: events, isLoading } = useQuery({
    queryKey: ["medications", medicationId, "intake"],
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medicationId}/intake`);
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data as IntakeEvent[];
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-20 items-center justify-center">
        <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (!events?.length) {
    return (
      <p className="text-muted-foreground py-4 text-center text-sm">
        Noch keine Einnahmen für {medicationName}
      </p>
    );
  }

  // Group by day
  const grouped = new Map<string, IntakeEvent[]>();
  for (const event of events) {
    const day = new Date(event.scheduledFor).toLocaleDateString("de-DE", {
      timeZone: "Europe/Berlin",
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    });
    const list = grouped.get(day) ?? [];
    list.push(event);
    grouped.set(day, list);
  }

  return (
    <div className="space-y-3">
      {[...grouped.entries()].map(([day, dayEvents]) => (
        <div key={day} className="space-y-1">
          <p className="text-muted-foreground text-xs font-medium">{day}</p>
          <div className="flex flex-wrap gap-1.5">
            {dayEvents.map((event) => (
              <Badge
                key={event.id}
                variant={event.skipped ? "outline" : "secondary"}
                className={
                  event.skipped
                    ? "text-muted-foreground gap-1"
                    : "gap-1 bg-green-500/20 text-green-400"
                }
              >
                {event.skipped ? (
                  <SkipForward className="h-3 w-3" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                {new Date(event.scheduledFor).toLocaleTimeString("de-DE", {
                  timeZone: "Europe/Berlin",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                {event.source !== "WEB" && (
                  <span className="text-[10px] opacity-60">{event.source}</span>
                )}
              </Badge>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
