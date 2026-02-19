"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { MedicationForm } from "@/components/medications/medication-form";
import { MedicationCard } from "@/components/medications/medication-card";
import { IntakeTimeline } from "@/components/medications/intake-timeline";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Plus, Pill } from "lucide-react";

interface Schedule {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
}

interface Medication {
  id: string;
  name: string;
  dose: string;
  active: boolean;
  schedules: Schedule[];
}

export default function MedicationsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMed, setEditingMed] = useState<Medication | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: medications, isLoading } = useQuery({
    queryKey: ["medications"],
    queryFn: async () => {
      const res = await fetch("/api/medications");
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data as Medication[];
    },
    enabled: isAuthenticated,
  });

  function openCreate() {
    setEditingMed(null);
    setDialogOpen(true);
  }

  function openEdit(med: Medication) {
    setEditingMed(med);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingMed(null);
  }

  if (authLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Medikamente</h1>
          <p className="text-muted-foreground text-sm">
            Bitte anmelden, um Medikamente zu verwalten.
          </p>
        </div>
      </div>
    );
  }

  const activeMeds = medications?.filter((m) => m.active) ?? [];
  const inactiveMeds = medications?.filter((m) => !m.active) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Medikamente</h1>
          <p className="text-muted-foreground text-sm">
            Medikation, Zeitpläne & Einnahmen
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          Medikament
        </Button>
      </div>

      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : !medications?.length ? (
        <div className="bg-card border-border flex h-64 items-center justify-center rounded-xl border">
          <div className="text-muted-foreground flex flex-col items-center gap-2">
            <Pill className="h-8 w-8" />
            <p>Noch keine Medikamente angelegt</p>
            <Button variant="outline" size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Erstes Medikament anlegen
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Active medications */}
          {activeMeds.length > 0 && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {activeMeds.map((med) => (
                  <div key={med.id} className="space-y-2">
                    <MedicationCard medication={med} onEdit={openEdit} />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground w-full text-xs"
                      onClick={() =>
                        setExpandedId(expandedId === med.id ? null : med.id)
                      }
                    >
                      {expandedId === med.id
                        ? "Verlauf ausblenden"
                        : "Einnahme-Verlauf"}
                    </Button>
                    {expandedId === med.id && (
                      <div className="bg-card border-border rounded-lg border p-3">
                        <IntakeTimeline
                          medicationId={med.id}
                          medicationName={med.name}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Inactive medications */}
          {inactiveMeds.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-muted-foreground text-sm font-medium">
                Inaktiv ({inactiveMeds.length})
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {inactiveMeds.map((med) => (
                  <MedicationCard
                    key={med.id}
                    medication={med}
                    onEdit={openEdit}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingMed ? "Medikament bearbeiten" : "Neues Medikament"}
            </DialogTitle>
          </DialogHeader>
          <MedicationForm
            initial={
              editingMed
                ? {
                    id: editingMed.id,
                    name: editingMed.name,
                    dose: editingMed.dose,
                    schedules: editingMed.schedules.map((s) => ({
                      windowStart: s.windowStart,
                      windowEnd: s.windowEnd,
                      label: s.label ?? "",
                    })),
                  }
                : undefined
            }
            onSuccess={closeDialog}
            onCancel={closeDialog}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
