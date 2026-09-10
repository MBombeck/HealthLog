"use client";

/**
 * v1.18.1 — per-episode detail page (`/illness/[id]`), mirroring
 * `/labs/[biomarkerId]`. Born-gated on the resolved `modules.illness` flag;
 * an unauthenticated visitor is bounced to login, an account without the
 * module opted in is bounced home (every `/api/illness/*` route also enforces
 * the gate server-side, so this is a UX redirect, not the security boundary).
 */
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageAuthGate } from "@/components/ui/page-auth-gate";

import { IllnessEpisodeDetail } from "@/components/illness/illness-episode-detail";
import { BackLink } from "@/components/ui/back-link";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";

export default function IllnessEpisodePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { user, isAuthenticated, isLoading } = useAuth();
  const mounted = useMounted();
  const router = useRouter();
  const { t } = useTranslations();

  const enabled = user?.modules?.illness === true;

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.push("/auth/login");
    } else if (!enabled) {
      router.push("/");
    }
  }, [isLoading, isAuthenticated, enabled, router]);

  if (!mounted || isLoading || !isAuthenticated || !enabled) {
    return <PageAuthGate label={t("common.loading")} />;
  }

  return (
    <div className="space-y-6">
      <BackLink href="/illness" label={t("illness.backToList")} />
      <IllnessEpisodeDetail episodeId={id} />
    </div>
  );
}
