"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Check,
  SkipForward,
  Clock,
  Flame,
  Pencil,
  Loader2,
} from "lucide-react";

interface Schedule {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
}

interface Medication {
  id: string;
  name: string;
  dose: string;
  category: "BLOOD_PRESSURE" | "VITAMIN" | "OTHER";
  active: boolean;
  schedules: Schedule[];
}

interface ComplianceData {
  compliance7: {
    totalExpected: number;
    taken: number;
    skipped: number;
    missed: number;
    rate: number;
    streak: number;
  };
  compliance30: {
    rate: number;
  };
}

interface MedicationCardProps {
  medication: Medication;
  onEdit: (med: Medication) => void;
}

export function MedicationCard({ medication, onEdit }: MedicationCardProps) {
  const queryClient = useQueryClient();
  const [intakeLoading, setIntakeLoading] = useState<string | null>(null);

  const { data: compliance } = useQuery({
    queryKey: ["medications", medication.id, "compliance"],
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medication.id}/compliance`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as ComplianceData;
    },
    staleTime: 30 * 1000,
  });

  async function recordIntake(skipped: boolean) {
    const key = skipped ? "skip" : "take";
    setIntakeLoading(key);
    try {
      const res = await fetch(`/api/medications/${medication.id}/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipped }),
      });
      if (res.ok) {
        await queryClient.invalidateQueries({
          queryKey: ["medications"],
        });
      }
    } finally {
      setIntakeLoading(null);
    }
  }

  const rate7 = compliance?.compliance7.rate ?? 0;
  const streak = compliance?.compliance7.streak ?? 0;
  const categoryLabel =
    medication.category === "BLOOD_PRESSURE"
      ? "Blutdrucksenker"
      : medication.category === "VITAMIN"
        ? "Vitamine"
        : "Sonstiges";
  const sortedSchedules = [...medication.schedules].sort(
    (a, b) =>
      a.windowStart.localeCompare(b.windowStart) ||
      a.windowEnd.localeCompare(b.windowEnd),
  );

  return (
    <Card className={medication.active ? "" : "opacity-60"}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg">{medication.name}</CardTitle>
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <span>{medication.dose}</span>
              <Badge variant="outline" className="text-xs">
                {categoryLabel}
              </Badge>
            </div>
          </div>
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onEdit(medication)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Schedule badges */}
        <div className="flex flex-wrap gap-2">
          {sortedSchedules.map((s) => (
            <Badge key={s.id} variant="secondary" className="gap-1">
              <Clock className="h-3 w-3" />
              {s.label ? `${s.label}: ` : ""}
              {s.windowStart}–{s.windowEnd}
              {s.dose && (
                <span className="ml-1 font-medium text-purple-400">
                  {s.dose}
                </span>
              )}
            </Badge>
          ))}
        </div>

        {/* Compliance bar */}
        {medication.active && compliance && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">7-Tage-Compliance</span>
              <span className="font-medium">{rate7}%</span>
            </div>
            <Progress value={rate7} className="h-2" />
            <div className="flex items-center gap-4 text-xs">
              <span className="text-muted-foreground">
                30 Tage: {compliance.compliance30.rate}%
              </span>
              {streak > 0 && (
                <span className="flex items-center gap-1 font-medium text-orange-400">
                  <Flame className="h-3.5 w-3.5" />
                  {streak} Tage Serie
                </span>
              )}
            </div>
          </div>
        )}

        {/* Quick actions */}
        {medication.active && (
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              onClick={() => recordIntake(false)}
              disabled={!!intakeLoading}
            >
              {intakeLoading === "take" ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="mr-1 h-3.5 w-3.5" />
              )}
              Genommen
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => recordIntake(true)}
              disabled={!!intakeLoading}
            >
              {intakeLoading === "skip" ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <SkipForward className="mr-1 h-3.5 w-3.5" />
              )}
              Übersprungen
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
