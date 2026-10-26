import type { FormEvent } from "react";

import { useTranslations } from "@/lib/i18n/context";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS } from "@/lib/record-settings";

import {
  asRecord,
  FormFooter,
  ManagedSwitchRow,
  type SettingsFormProps,
} from "./form-kit";

/**
 * What a Modules save actually sends.
 *
 * The direct modules ride along whether or not they moved — they are one blob
 * the route merges, and a key that did not change writes the value it already
 * had. `cycleTrackingEnabled` is not one of them: it is a DELEGATED module
 * whose column the cycle gate honours OVER the sex-derived default, so sending
 * the switch's current position on every save freezes the derivation. A record
 * created with no recorded sex derives cycle OFF; a guardian who turns Labs off
 * and saves would write that OFF as an explicit answer, and the record's sex
 * being set to FEMALE afterwards would then leave cycle off with nothing on
 * screen to say why. It also put `cycleTrackingEnabled` in the record's audit
 * trail on every save of any module.
 *
 * So it is sent only when it differs from the value the form opened on, which
 * is what the managed-record edit form's `managedProfileEditPatch` already does
 * for its own five fields.
 *
 * Exported and pure because it is the decision this form makes, and a decision
 * about what NOT to send is invisible in the rendered markup.
 */
export function managedModulesPatch(
  settings: Record<string, unknown>,
  form: FormData,
): {
  modulePreferences: Record<string, boolean>;
  cycleTrackingEnabled?: boolean;
} {
  const cycleTrackingEnabled = form.get("cycleTrackingEnabled") === "on";
  // The same expression the switch is seeded from, so "differs from what the
  // form opened on" is one statement rather than two that can drift.
  const loaded = settings.cycleTrackingEnabled === true;
  return {
    modulePreferences: Object.fromEntries(
      Object.keys(MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS).map((key) => [
        key,
        form.get(key) === "on",
      ]),
    ),
    ...(cycleTrackingEnabled !== loaded ? { cycleTrackingEnabled } : {}),
  };
}

export function ModulesSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
  error,
}: SettingsFormProps) {
  const { t } = useTranslations();
  const preferences = asRecord(settings.modulePreferences);
  const entries = Object.entries(MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS) as [
    keyof typeof MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS,
    boolean,
  ][];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(managedModulesPatch(settings, new FormData(event.currentTarget)));
  }

  return (
    <form className="space-y-3" onSubmit={submit}>
      {entries.map(([key, defaultEnabled]) => (
        <ManagedSwitchRow
          key={key}
          name={key}
          label={t(MODULE_REGISTRY[key].labelKey)}
          defaultChecked={
            preferences[key] === undefined
              ? defaultEnabled
              : preferences[key] === true
          }
          disabled={disabled}
        />
      ))}
      {/* Cycle sits below the rest because it is not one of
          them: it is a DELEGATED module, so its state lives in the record's own
          cycle profile rather than in the module blob, and it had no row here
          at all. A guardian could not turn it off for a record whose sex says
          it should be on, which is the case #939 was opened about. */}
      <ManagedSwitchRow
        name="cycleTrackingEnabled"
        label={t(MODULE_REGISTRY.cycle.labelKey)}
        defaultChecked={settings.cycleTrackingEnabled === true}
        disabled={disabled}
      />
      <FormFooter disabled={disabled} label={saveLabel} error={error} />
    </form>
  );
}
