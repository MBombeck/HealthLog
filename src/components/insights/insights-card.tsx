"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkles, RefreshCw, Loader2, AlertTriangle } from "lucide-react";

interface InsightsOutput {
  changed: string;
  stable: string;
  drivers: string;
  nextSteps: string;
  confidence: "niedrig" | "mittel" | "hoch";
  limitations: string;
}

interface InsightsResponse {
  insights: InsightsOutput;
  cached: boolean;
  cachedAt?: string;
}

const CONFIDENCE_COLORS: Record<string, string> = {
  niedrig: "bg-orange-500/20 text-orange-400",
  mittel: "bg-yellow-500/20 text-yellow-400",
  hoch: "bg-green-500/20 text-green-400",
};

export function InsightsCard() {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  // Check if insights are configured
  const { data: settings } = useQuery({
    queryKey: ["insights", "settings"],
    queryFn: async () => {
      const res = await fetch("/api/insights/settings");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as {
        hasKey: boolean;
        privacyMode: string;
        lastInsightAt: string | null;
      };
    },
    enabled: isAuthenticated,
  });

  const generate = useMutation({
    mutationFn: async (force: boolean) => {
      const res = await fetch("/api/insights/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      return json.data as InsightsResponse;
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  // Don't show if no API key configured
  if (!settings?.hasKey) return null;

  const insights = generate.data?.insights;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="text-dracula-purple h-5 w-5" />
            <CardTitle className="text-lg">KI-Insights</CardTitle>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => generate.mutate(!insights)}
            disabled={generate.isPending}
          >
            {generate.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            {insights ? "Aktualisieren" : "Generieren"}
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {error && (
          <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg p-3 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {generate.isPending && !insights && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-dracula-purple h-6 w-6 animate-spin" />
            <span className="text-muted-foreground ml-2 text-sm">
              Analysiere Gesundheitsdaten...
            </span>
          </div>
        )}

        {insights && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge className={CONFIDENCE_COLORS[insights.confidence] ?? ""}>
                Konfidenz: {insights.confidence}
              </Badge>
              {generate.data?.cached && (
                <Badge variant="outline" className="text-xs">
                  Gecacht
                </Badge>
              )}
            </div>

            <Section title="Was hat sich verändert" text={insights.changed} />
            <Section title="Was ist stabil" text={insights.stable} />
            <Section title="Mögliche Zusammenhänge" text={insights.drivers} />
            <Section title="Nächste Schritte" text={insights.nextSteps} />

            <div className="bg-muted/50 rounded-lg p-3">
              <p className="text-muted-foreground text-xs">
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                {insights.limitations}
              </p>
            </div>
          </div>
        )}

        {!insights && !generate.isPending && !error && (
          <p className="text-muted-foreground py-4 text-center text-sm">
            Klicke auf &quot;Generieren&quot; für KI-basierte Insights deiner
            Gesundheitsdaten.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Section({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">{title}</h4>
      <p className="text-muted-foreground text-sm">{text}</p>
    </div>
  );
}
