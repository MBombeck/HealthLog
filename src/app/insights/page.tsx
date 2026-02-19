"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { InsightsCard } from "@/components/insights/insights-card";
import {
  Activity,
  Heart,
  Scale,
  Target,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Info,
  AlertTriangle,
  Pill,
  TrendingUp,
} from "lucide-react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { ComplianceCharts } from "@/components/charts/compliance-charts";

interface ComprehensiveData {
  summaries: Record<
    string,
    {
      latest: number | null;
      avg30: number | null;
      slope30: { slope: number; direction: string } | null;
      anomalyCount: number;
    }
  >;
  bmi: number | null;
  bmiClassification: {
    category: string;
    color: string;
    severity: string;
  } | null;
  bpClassification: {
    category: string;
    color: string;
    severity: string;
  } | null;
  bpPctInTarget: number | null;
  bpTargets: {
    sysLow: number;
    sysHigh: number;
    diaLow: number;
    diaHigh: number;
  } | null;
  weightBpCorrelation: { r: number; strength: string; n: number } | null;
  scatterData: Array<{ weight: number; sysBP: number }>;
  bpMedicationCorrelation: {
    r: number;
    strength: string;
    n: number;
    medicationCount: number;
  } | null;
  bpMedicationScatterData: Array<{ continuityPct: number; sysBP: number }>;
  medications: Array<{
    name: string;
    dose: string;
    category: "BLOOD_PRESSURE" | "VITAMIN" | "OTHER";
    compliance7: number;
    compliance30: number;
    streak: number;
    taken7: number;
    skipped7: number;
    missed7: number;
  }>;
  alerts: Array<{ level: string; title: string; message: string }>;
  hasOpenAiKey: boolean;
  dataSpanDays: number;
  totalMeasurements: number;
}

const ALERT_STYLES: Record<
  string,
  { border: string; icon: typeof CheckCircle2; iconColor: string }
> = {
  success: {
    border: "border-l-green-500",
    icon: CheckCircle2,
    iconColor: "text-green-500",
  },
  info: { border: "border-l-cyan-500", icon: Info, iconColor: "text-cyan-500" },
  warning: {
    border: "border-l-orange-500",
    icon: AlertTriangle,
    iconColor: "text-orange-500",
  },
  danger: {
    border: "border-l-red-500",
    icon: AlertCircle,
    iconColor: "text-red-500",
  },
};

const STRENGTH_LABELS: Record<string, string> = {
  stark: "Starke Korrelation",
  moderat: "Moderate Korrelation",
  schwach: "Schwache Korrelation",
  keine: "Keine Korrelation",
};

export default function InsightsPage() {
  const { isAuthenticated } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["insights", "comprehensive"],
    queryFn: async () => {
      const res = await fetch("/api/insights/comprehensive");
      if (!res.ok) throw new Error("Fehler beim Laden");
      const json = await res.json();
      return json.data as ComprehensiveData;
    },
    enabled: isAuthenticated,
  });

  const { data: medications } = useQuery({
    queryKey: ["medications"],
    queryFn: async () => {
      const res = await fetch("/api/medications");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as Array<{
        id: string;
        name: string;
        dose: string;
        active: boolean;
      }>;
    },
    enabled: isAuthenticated,
  });

  const activeMeds = medications?.filter((m) => m.active) ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-muted-foreground py-20 text-center">
        Keine Daten verfügbar.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Insights</h1>
        <p className="text-muted-foreground text-sm">
          {data.totalMeasurements} Messungen über {data.dataSpanDays} Tage
        </p>
      </div>

      {/* Section 1: Health Status */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Gesundheitsstatus</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* BMI Card */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Scale className="text-dracula-purple h-4 w-4" />
                <CardTitle className="text-sm font-medium">BMI</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {data.bmi != null && data.bmiClassification ? (
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold">{data.bmi}</span>
                    <span className="text-muted-foreground text-sm">kg/m²</span>
                  </div>
                  <Badge
                    style={{
                      backgroundColor: `${data.bmiClassification.color}20`,
                      color: data.bmiClassification.color,
                    }}
                  >
                    {data.bmiClassification.category}
                  </Badge>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Keine Gewichtsdaten oder Größe nicht hinterlegt.
                </p>
              )}
            </CardContent>
          </Card>

          {/* BP Classification Card */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Heart className="text-dracula-pink h-4 w-4" />
                <CardTitle className="text-sm font-medium">Blutdruck</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {data.bpClassification &&
              data.summaries.BLOOD_PRESSURE_SYS?.avg30 &&
              data.summaries.BLOOD_PRESSURE_DIA?.avg30 ? (
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold">
                      {Math.round(data.summaries.BLOOD_PRESSURE_SYS.avg30)}
                    </span>
                    <span className="text-muted-foreground text-lg">/</span>
                    <span className="text-2xl font-bold">
                      {Math.round(data.summaries.BLOOD_PRESSURE_DIA.avg30)}
                    </span>
                    <span className="text-muted-foreground text-sm">mmHg</span>
                  </div>
                  <Badge
                    style={{
                      backgroundColor: `${data.bpClassification.color}20`,
                      color: data.bpClassification.color,
                    }}
                  >
                    {data.bpClassification.category}
                  </Badge>
                  <p className="text-muted-foreground text-xs">
                    30-Tage-Durchschnitt · ESC/ESH 2018
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Nicht genügend Blutdruckdaten.
                </p>
              )}
            </CardContent>
          </Card>

          {/* BP Target Adherence Card */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Target className="text-dracula-green h-4 w-4" />
                <CardTitle className="text-sm font-medium">
                  Zielbereich
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {data.bpPctInTarget != null && data.bpTargets ? (
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold">
                      {data.bpPctInTarget}%
                    </span>
                    <span className="text-muted-foreground text-sm">
                      im Zielbereich
                    </span>
                  </div>
                  <Progress value={data.bpPctInTarget} className="h-2" />
                  <p className="text-muted-foreground text-xs">
                    Ziel: {data.bpTargets.sysLow}–{data.bpTargets.sysHigh} /{" "}
                    {data.bpTargets.diaLow}–{data.bpTargets.diaHigh} mmHg
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  {data.bpTargets
                    ? "Nicht genügend Blutdruckdaten."
                    : "Geburtsdatum nicht hinterlegt."}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Section 2: Alerts */}
      {data.alerts.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Hinweise & Empfehlungen</h2>
          <div className="space-y-2">
            {data.alerts.map((alert, i) => {
              const style = ALERT_STYLES[alert.level] ?? ALERT_STYLES.info;
              const AlertIcon = style.icon;
              return (
                <Card key={i} className={`border-l-4 ${style.border}`}>
                  <CardContent className="flex gap-3 py-3">
                    <AlertIcon
                      className={`mt-0.5 h-4 w-4 shrink-0 ${style.iconColor}`}
                    />
                    <div>
                      <p className="text-sm font-medium">{alert.title}</p>
                      <p className="text-muted-foreground text-sm">
                        {alert.message}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {/* Section 3: Correlations */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Korrelationen</h2>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp className="text-dracula-cyan h-4 w-4" />
                <CardTitle className="text-sm font-medium">
                  Gewicht vs. Blutdruck (Systolisch)
                </CardTitle>
              </div>
              {data.weightBpCorrelation && (
                <Badge variant="outline">
                  r = {data.weightBpCorrelation.r} ·{" "}
                  {STRENGTH_LABELS[data.weightBpCorrelation.strength] ??
                    data.weightBpCorrelation.strength}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {data.scatterData.length >= 5 ? (
              <div className="space-y-2">
                <ResponsiveContainer width="100%" height={250}>
                  <ScatterChart
                    margin={{ top: 10, right: 20, bottom: 36, left: 12 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="hsl(var(--border))"
                    />
                    <XAxis
                      dataKey="weight"
                      type="number"
                      name="Gewicht"
                      unit=" kg"
                      tick={{ fontSize: 12 }}
                      tickMargin={8}
                      height={52}
                      interval="preserveStartEnd"
                      padding={{ left: 8, right: 8 }}
                      tickFormatter={(value: number) => value.toFixed(1)}
                      label={{
                        value: "Gewicht (kg)",
                        position: "bottom",
                        fontSize: 12,
                      }}
                    />
                    <YAxis
                      dataKey="sysBP"
                      type="number"
                      name="Sys. BP"
                      unit=" mmHg"
                      tick={{ fontSize: 12 }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "0.5rem",
                        fontSize: "0.75rem",
                      }}
                      formatter={(value, name) => [
                        `${value} ${name === "Gewicht" ? "kg" : "mmHg"}`,
                        name,
                      ]}
                    />
                    <Scatter
                      data={data.scatterData}
                      fill="hsl(var(--primary))"
                      opacity={0.7}
                    />
                  </ScatterChart>
                </ResponsiveContainer>
                {data.weightBpCorrelation && (
                  <p className="text-muted-foreground text-center text-xs">
                    {data.weightBpCorrelation.strength === "stark"
                      ? "Es besteht ein starker Zusammenhang zwischen Gewicht und Blutdruck."
                      : data.weightBpCorrelation.strength === "moderat"
                        ? "Es besteht ein moderater Zusammenhang zwischen Gewicht und Blutdruck."
                        : data.weightBpCorrelation.strength === "schwach"
                          ? "Es besteht ein schwacher Zusammenhang zwischen Gewicht und Blutdruck."
                          : "Kein erkennbarer Zusammenhang zwischen Gewicht und Blutdruck."}{" "}
                    (n = {data.weightBpCorrelation.n})
                  </p>
                )}
              </div>
            ) : (
              <div className="text-muted-foreground flex flex-col items-center justify-center py-8 text-sm">
                <Activity className="mb-2 h-8 w-8 opacity-50" />
                <p>Zu wenig Daten für Korrelationsanalyse.</p>
                <p className="text-xs">
                  Mindestens 5 zeitlich übereinstimmende Gewichts- und
                  Blutdruckmessungen nötig.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Pill className="text-dracula-orange h-4 w-4" />
                <CardTitle className="text-sm font-medium">
                  Blutdrucksenker-Kontinuität vs. Blutdruck (Systolisch)
                </CardTitle>
              </div>
              {data.bpMedicationCorrelation && (
                <Badge variant="outline">
                  r = {data.bpMedicationCorrelation.r} ·{" "}
                  {STRENGTH_LABELS[data.bpMedicationCorrelation.strength] ??
                    data.bpMedicationCorrelation.strength}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {data.bpMedicationScatterData.length >= 5 ? (
              <div className="space-y-2">
                <ResponsiveContainer width="100%" height={250}>
                  <ScatterChart
                    margin={{ top: 10, right: 20, bottom: 36, left: 12 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="hsl(var(--border))"
                    />
                    <XAxis
                      dataKey="continuityPct"
                      type="number"
                      name="Kontinuität"
                      unit="%"
                      tick={{ fontSize: 12 }}
                      tickMargin={8}
                      height={52}
                      interval="preserveStartEnd"
                      padding={{ left: 8, right: 8 }}
                      label={{
                        value: "Kontinuität Blutdrucksenker (%)",
                        position: "bottom",
                        fontSize: 12,
                      }}
                    />
                    <YAxis
                      dataKey="sysBP"
                      type="number"
                      name="Sys. BP"
                      unit=" mmHg"
                      tick={{ fontSize: 12 }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "0.5rem",
                        fontSize: "0.75rem",
                      }}
                      formatter={(value, name) => [
                        `${value}${name === "Kontinuität" ? "%" : " mmHg"}`,
                        name,
                      ]}
                    />
                    <Scatter
                      data={data.bpMedicationScatterData}
                      fill="hsl(var(--chart-3))"
                      opacity={0.7}
                    />
                  </ScatterChart>
                </ResponsiveContainer>
                {data.bpMedicationCorrelation && (
                  <p className="text-muted-foreground text-center text-xs">
                    {data.bpMedicationCorrelation.r < 0
                      ? "Negativer Zusammenhang: höhere Kontinuität geht eher mit niedrigerem systolischen Blutdruck einher."
                      : data.bpMedicationCorrelation.r > 0
                        ? "Positiver Zusammenhang: höhere Kontinuität geht in deinen Daten eher mit höherem systolischen Blutdruck einher."
                        : "Kein erkennbarer Zusammenhang in deinen Daten."}{" "}
                    (n = {data.bpMedicationCorrelation.n},{" "}
                    {data.bpMedicationCorrelation.medicationCount}{" "}
                    Blutdrucksenker)
                  </p>
                )}
              </div>
            ) : (
              <div className="text-muted-foreground flex flex-col items-center justify-center py-8 text-sm">
                <Activity className="mb-2 h-8 w-8 opacity-50" />
                <p>Zu wenig Daten für diese Analyse.</p>
                <p className="text-xs">
                  Markiere Medikamente als Blutdrucksenker und erfasse
                  ausreichend Einnahmen + Blutdruckmessungen.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Section 4: Medication Compliance */}
      {data.medications.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Medikamenten-Compliance</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {data.medications.map((med) => (
              <Card key={med.name}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Pill className="text-dracula-orange h-4 w-4" />
                      <CardTitle className="text-sm font-medium">
                        {med.name}
                      </CardTitle>
                    </div>
                    {med.streak > 0 && (
                      <Badge variant="outline" className="text-xs">
                        {med.streak} Tage Serie
                      </Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs">{med.dose}</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span>7-Tage-Compliance</span>
                      <span className="font-medium">{med.compliance7}%</span>
                    </div>
                    <Progress value={med.compliance7} className="h-2" />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span>30-Tage-Compliance</span>
                      <span className="font-medium">{med.compliance30}%</span>
                    </div>
                    <Progress value={med.compliance30} className="h-2" />
                  </div>
                  <div className="text-muted-foreground flex justify-between text-xs">
                    <span>
                      <span className="text-green-500">{med.taken7}</span>{" "}
                      genommen
                    </span>
                    <span>
                      <span className="text-orange-500">{med.skipped7}</span>{" "}
                      übersprungen
                    </span>
                    <span>
                      <span className="text-red-500">{med.missed7}</span>{" "}
                      verpasst
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Section 5: Compliance Charts (Heatmap + Trend) */}
      {activeMeds.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Compliance-Verlauf</h2>
          <ComplianceCharts medications={activeMeds} />
        </section>
      )}

      {/* Section 6: AI Insights */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">KI-Insights</h2>
        {data.hasOpenAiKey ? (
          <InsightsCard />
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-8">
              <p className="text-muted-foreground text-sm">
                Konfiguriere einen OpenAI API-Key in den Einstellungen, um
                KI-basierte Insights zu erhalten.
              </p>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
