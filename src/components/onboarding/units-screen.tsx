"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { usePersonFlow } from "@/components/onboarding/person-flow";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { apiPut } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import type { PersonSegmentId } from "@/lib/onboarding/wizard-steps";
import { queryKeys } from "@/lib/query-keys";
import { storeTimezone } from "@/lib/timezone-mirror";
import {
  DEFAULT_TIMEZONE,
  detectBrowserTimezone,
  listSupportedTimezones,
} from "@/lib/tz/format";

type GlucoseUnit = "mg/dL" | "mmol/L";
type UnitPreference = "metric" | "imperial";

/**
 * The basics (the `units` step since 1.39): display name, time zone and the
 * units, on one screen. Every field arrives filled (the account's name, the
 * zone this browser reported at sign-up, the account's units), so "Continue"
 * confirms them. The glucose unit is asked only when glucose is one of the
 * areas, preselected.
 *
 * The name goes through the profile route, the rest through the answers
 * route, which writes the same account columns Settings does.
 */
export function UnitsScreen({
  state,
  plan,
}: {
  state: OnboardingStateDto;
  plan: readonly PersonSegmentId[] | null;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const flow = usePersonFlow(state, plan, "units");
  const askGlucose = state.needs.areas.includes("glucose");
  const zones = useMemo(() => listSupportedTimezones(), []);
  const mounted = useMounted();

  const [name, setName] = useState(() => user?.displayName ?? "");
  const [timezone, setTimezone] = useState(
    () => state.needs.units.timezone ?? user?.timezone ?? DEFAULT_TIMEZONE,
  );
  const [unitPreference, setUnitPreference] = useState<UnitPreference>(
    () => state.needs.units.unitPreference ?? user?.unitPreference ?? "metric",
  );
  const [glucoseUnit, setGlucoseUnit] = useState<GlucoseUnit>(
    () =>
      state.needs.units.glucoseUnit ??
      (user?.glucoseUnit === "mmol/L" ? "mmol/L" : "mg/dL"),
  );
  const [working, setWorking] = useState(false);
  const deviceZone = mounted ? detectBrowserTimezone() : "";

  async function next() {
    if (working) return;
    setWorking(true);
    try {
      const trimmed = name.trim();
      if (trimmed !== (user?.displayName ?? "")) {
        await apiPut("/api/auth/profile", { displayName: trimmed || null });
        await queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      }
      const written = await flow.record({
        step: "units",
        units: {
          unitPreference,
          timezone,
          ...(askGlucose ? { glucoseUnit } : {}),
        },
      });
      storeTimezone(timezone);
      await flow.advance(written);
    } catch (err) {
      setWorking(false);
      flow.fail(err);
    }
  }

  return (
    <section
      aria-labelledby="onboarding-units-title"
      className="flex flex-1 flex-col"
    >
      <StepHeading
        id="onboarding-units-title"
        title={t("setup.person.units.title")}
        description={t("setup.person.units.body")}
      />
      <div className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="onboarding-display-name">
            {t("setup.person.units.name")}
          </Label>
          <Input
            id="onboarding-display-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="nickname"
            maxLength={100}
          />
        </div>

        <div className="space-y-2" data-slot="onboarding-question-timezone">
          <Label htmlFor="onboarding-timezone">{t("settings.timezone")}</Label>
          <NativeSelect
            id="onboarding-timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full"
            aria-describedby="onboarding-timezone-hint"
          >
            {!zones.includes(timezone) && timezone.length > 0 ? (
              <option value={timezone}>{timezone}</option>
            ) : null}
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </NativeSelect>
          <p
            id="onboarding-timezone-hint"
            className="text-muted-foreground text-xs"
          >
            {deviceZone && deviceZone !== timezone ? (
              <button
                type="button"
                className="text-primary underline underline-offset-4"
                data-slot="onboarding-timezone-use-device"
                onClick={() => setTimezone(deviceZone)}
              >
                {t("settings.timezoneUseDevice", { zone: deviceZone })}
              </button>
            ) : (
              t("setup.person.units.timezoneHint")
            )}
          </p>
        </div>

        <div
          className="space-y-2"
          data-slot="onboarding-question-unit-preference"
        >
          <p className="text-sm font-medium" id="onboarding-weight-legend">
            {t("onboarding.flow.units.weightLegend")}
          </p>
          <Segmented
            label={t("onboarding.flow.units.weightLegend")}
            value={unitPreference}
            onChange={setUnitPreference}
            options={[
              {
                value: "metric",
                label: t("onboarding.flow.units.options.metric"),
              },
              {
                value: "imperial",
                label: t("onboarding.flow.units.options.imperial"),
              },
            ]}
          />
        </div>

        {askGlucose ? (
          <div
            className="space-y-2"
            data-slot="onboarding-question-glucose-unit"
          >
            <p className="text-sm font-medium">
              {t("onboarding.flow.units.glucoseLegend")}
            </p>
            <Segmented
              label={t("onboarding.flow.units.glucoseLegend")}
              value={glucoseUnit}
              onChange={setGlucoseUnit}
              options={[
                { value: "mmol/L", label: "mmol/l" },
                { value: "mg/dL", label: "mg/dl" },
              ]}
            />
          </div>
        ) : null}
      </div>

      <StepActions
        primary={{
          label: t("onboarding.shell.next"),
          onClick: () => void next(),
        }}
        pending={working}
      />
    </section>
  );
}
