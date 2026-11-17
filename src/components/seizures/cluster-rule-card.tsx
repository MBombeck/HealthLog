"use client";

/**
 * The record's cluster rule (#1368): N seizures within W hours. The default
 * is 2 in 24 hours; the rule belongs in the person's emergency plan, so it is
 * set here to match the plan, with NICE's 3 in 24 hours named beside it.
 */
import { useState, type ComponentType } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { TileHeader } from "@/components/insights/tile-header";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import type { ClusterRule } from "@/lib/seizures/derive";

import { useSeizureSettingsMutation } from "./use-seizures";

export function ClusterRuleCard({
  icon,
  rule,
  niceRule,
  canManage,
}: {
  icon: ComponentType<{ className?: string }>;
  rule: ClusterRule;
  niceRule: ClusterRule;
  canManage: boolean;
}) {
  const { t } = useTranslations();
  const save = useSeizureSettingsMutation();
  const [count, setCount] = useState(String(rule.count));
  const [hours, setHours] = useState(String(rule.windowHours));
  const [error, setError] = useState<string | null>(null);
  const n = Number(count);
  const h = Number(hours);
  const valid =
    Number.isInteger(n) &&
    n >= 2 &&
    n <= 20 &&
    Number.isInteger(h) &&
    h >= 1 &&
    h <= 168;
  const changed = n !== rule.count || h !== rule.windowHours;

  return (
    <Card>
      <CardHeader>
        <TileHeader icon={icon} title={t("seizures.rule.title")} />
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-foreground text-sm">
          {t("seizures.rule.explainer", {
            niceCount: niceRule.count,
            niceHours: niceRule.windowHours,
          })}
        </p>
        <div className="grid grid-cols-2 gap-4">
          <FieldGroup
            htmlFor="seizure-rule-count"
            label={t("seizures.rule.count")}
          >
            <Input
              id="seizure-rule-count"
              inputMode="numeric"
              value={count}
              disabled={!canManage}
              onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))}
            />
          </FieldGroup>
          <FieldGroup
            htmlFor="seizure-rule-hours"
            label={t("seizures.rule.hours")}
          >
            <Input
              id="seizure-rule-hours"
              inputMode="numeric"
              value={hours}
              disabled={!canManage}
              onChange={(e) => setHours(e.target.value.replace(/\D/g, ""))}
            />
          </FieldGroup>
        </div>
        {!valid ? (
          <p className="text-destructive text-sm" role="alert">
            {t("seizures.rule.invalid")}
          </p>
        ) : null}
        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
        {canManage ? (
          <Button
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={!valid || !changed || save.isPending}
            onClick={async () => {
              setError(null);
              try {
                await save.mutateAsync({
                  clusterCount: n,
                  clusterWindowHours: h,
                });
                toastWrittenOutcome("success", t("seizures.rule.saved"));
              } catch (err) {
                setError(localizedApiError(err, t, "seizures.saveError"));
              }
            }}
            data-slot="seizure-rule-save"
          >
            {t("common.save")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
