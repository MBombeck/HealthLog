"use client";

import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { MoodForm } from "@/components/mood/mood-form";
import { MoodList } from "@/components/mood/mood-list";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTranslations } from "@/lib/i18n/context";

export default function StimmungPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { t } = useTranslations();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("mood.title")}
          </h1>
          <p className="text-muted-foreground hidden text-sm sm:block">
            {t("mood.subtitle")}
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              {t("mood.addEntry")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("mood.addEntry")}</DialogTitle>
            </DialogHeader>
            <MoodForm
              onSuccess={() => setDialogOpen(false)}
              onCancel={() => setDialogOpen(false)}
            />
          </DialogContent>
        </Dialog>
      </div>

      <MoodList />
    </div>
  );
}
