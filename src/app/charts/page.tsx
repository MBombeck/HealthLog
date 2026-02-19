"use client";

import { HealthChart } from "@/components/charts/health-chart";
import { MedicationIntakeChart } from "@/components/charts/medication-intake-chart";

export default function ChartsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Verlauf</h1>
        <p className="text-muted-foreground text-sm">
          Visualisierung deiner Gesundheitsdaten
        </p>
      </div>

      <MedicationIntakeChart />

      <HealthChart
        types={["WEIGHT"]}
        title="Gewicht"
        colors={["#bd93f9"]}
        unit="kg"
      />

      <HealthChart
        types={["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]}
        title="Blutdruck"
        colors={["#ff79c6", "#8be9fd"]}
        unit="mmHg"
      />

      <HealthChart
        types={["PULSE"]}
        title="Puls"
        colors={["#50fa7b"]}
        unit="bpm"
      />

      <HealthChart
        types={["BODY_FAT"]}
        title="Körperfett"
        colors={["#ffb86c"]}
        unit="%"
      />

      <HealthChart
        types={["SLEEP_DURATION"]}
        title="Schlaf"
        colors={["#8be9fd"]}
        unit="h"
      />

      <HealthChart
        types={["ACTIVITY_STEPS"]}
        title="Schritte"
        colors={["#50fa7b"]}
        unit=""
      />
    </div>
  );
}
