"use client";

import { useEffect, use, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { IntakeHistoryList } from "@/components/medications/intake-history-list";
import { ArrowLeft, Loader2, Plus } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "@/lib/i18n/context";

export default function IntakeHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const { t } = useTranslations();
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [authLoading, isAuthenticated, router]);

  const { data: medication, isLoading: medLoading } = useQuery({
    queryKey: ["medications", id],
    queryFn: async () => {
      const res = await fetch(`/api/medications/${id}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data as { id: string; name: string; dose: string };
    },
    enabled: isAuthenticated,
  });

  if (authLoading || medLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground -ml-2 gap-1"
        asChild
      >
        <Link href="/medications">
          <ArrowLeft className="h-4 w-4" />
          Zurück
        </Link>
      </Button>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("medications.intakeHistoryTitle")}
          </h1>
          {medication && (
            <p className="text-muted-foreground hidden text-sm sm:block">
              {medication.name} — {medication.dose}
            </p>
          )}
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t("medications.newIntake")}
        </Button>
      </div>

      <IntakeHistoryList
        medicationId={id}
        createOpen={createOpen}
        onCreateOpenChange={setCreateOpen}
      />
    </div>
  );
}
