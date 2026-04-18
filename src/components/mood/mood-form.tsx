"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, MoreHorizontal, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, moodDependentKeys } from "@/lib/query-keys";

const MOOD_LEVELS = [
  { value: "SUPER_GUT", score: 5, labelKey: "mood.levelSuperGut" },
  { value: "GUT", score: 4, labelKey: "mood.levelGut" },
  { value: "OKAY", score: 3, labelKey: "mood.levelOkay" },
  { value: "SCHLECHT", score: 2, labelKey: "mood.levelSchlecht" },
  { value: "LAUSIG", score: 1, labelKey: "mood.levelLausig" },
] as const;

interface MoodFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
}

function getDefaultMoodLoggedAtValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

export function MoodForm({ onSuccess, onCancel }: MoodFormProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [mood, setMood] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [moodLoggedAt, setMoodLoggedAt] = useState(getDefaultMoodLoggedAtValue);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForm() {
    setMood("");
    setTagsInput("");
    setMoodLoggedAt(getDefaultMoodLoggedAtValue());
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!mood) return;
    setError(null);
    setLoading(true);

    try {
      const timestamp = new Date(moodLoggedAt).toISOString();
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const res = await fetch("/api/mood-entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mood,
          tags: tags.length > 0 ? tags : undefined,
          moodLoggedAt: timestamp,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error);
        setLoading(false);
        return;
      }

      resetForm();
      await invalidateKeys(queryClient, moodDependentKeys);
      toast.success(t("common.saved"));
      onSuccess?.();
    } catch {
      setError(t("mood.saveError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label id="mood-level-label">{t("mood.moodLevel")}</Label>
        <div
          role="radiogroup"
          aria-labelledby="mood-level-label"
          className="grid grid-cols-5 gap-2"
        >
          {MOOD_LEVELS.map((level) => {
            const isSelected = mood === level.value;
            return (
              <button
                key={level.value}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => setMood(level.value)}
                className={`flex flex-col items-center gap-1 rounded-lg border p-2 text-center transition-colors ${
                  isSelected
                    ? "border-primary bg-primary/10 text-primary border-2"
                    : "border-border hover:bg-accent"
                }`}
              >
                <span className="text-lg font-semibold tabular-nums">
                  {level.score}
                </span>
                <span className="text-[10px] leading-tight sm:text-xs">
                  {t(level.labelKey)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="mood-logged-at">{t("mood.timestamp")}</Label>
        <Input
          id="mood-logged-at"
          type="datetime-local"
          value={moodLoggedAt}
          onChange={(e) => setMoodLoggedAt(e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="tags">
            {t("mood.tags")}{" "}
            <span className="text-muted-foreground font-normal">
              ({t("common.optional")})
            </span>
          </Label>
          <span className="text-muted-foreground text-xs">
            {t("mood.tagsHelp")}
          </span>
        </div>
        <Input
          id="tags"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder={t("mood.tagsPlaceholder")}
        />
      </div>

      {error && (
        <div role="alert" aria-live="assertive" className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9"
              disabled={loading}
              aria-label={t("common.moreOptions")}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={resetForm}>
              <RotateCcw className="mr-2 h-4 w-4" />
              {t("mood.formReset")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-2">
          {onCancel && (
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={loading}
            >
              {t("common.cancel")}
            </Button>
          )}
          <Button type="submit" disabled={loading || !mood}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            {t("common.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}
