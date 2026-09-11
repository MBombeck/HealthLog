"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateField } from "@/components/ui/date-field";
import { InfoPopover } from "@/components/ui/info-popover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { useQueryClientMounted } from "@/hooks/_internal/use-query-client-safe";
import { useModuleEnabled } from "@/hooks/use-module-enabled";
import { ApiError } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { useInviteGrant } from "@/lib/queries/use-account-grants";
import { SHARE_DOMAINS, type ShareDomain } from "@/lib/sharing/scope";
import { DEFAULT_TIMEZONE, isValidTimezone } from "@/lib/tz/format";
import { wallClockInTz, zonedWallClockToUtc } from "@/lib/tz/wall-clock";

/**
 * v1.37.0 — offering somebody access to this record.
 *
 * Three decisions now: who, what they may do, and how much of the record they
 * may open. All three are made once, here — a grant is fixed at the level and
 * over the sections it was offered with, nothing widens it later, and the way
 * to a wider one is a fresh invitation the other person accepts again. So this
 * form is the one screen where the owner's half of that consent is given, and
 * every label on it has to be worth reading.
 *
 * ## Why this shape and not the obvious one
 *
 * The obvious shape is three levels times eight sections laid out at once:
 * nineteen controls, all visible, all equal. It reads as a permissions matrix
 * and it makes the common case — "my partner can see everything" — look like
 * work somebody has to finish. So the form is two questions asked in order,
 * and the second one is a door rather than a grid:
 *
 *   * **What they may do** stays what it was, one radio per level, narrowest
 *     preselected, each with the sentence that says what it actually does
 *     rather than the word for it.
 *   * **What they may open** is two radios with nothing preselected. Whole
 *     record and narrowing are both a choice the owner makes, so neither is
 *     nudged: an untouched fieldset blocks the form rather than defaulting to
 *     the whole record. Choosing to narrow reveals the eight sections; a person
 *     who wants everything picks whole record and presses send. Nobody ever
 *     sees nineteen checkboxes.
 *
 * The two honest limits are stated inside the expanded state, where the
 * decision is actually being made, rather than in help text somebody would
 * have to go looking for: a section leaks through its own notes and names, and
 * the cross-record surfaces (dashboard, score, digest) do not appear at all for
 * a narrowed grant. Both are said before the checkboxes, not after them.
 *
 * Manage collapses the whole second question to one line, because management
 * is whole-record by construction. That is a design decision made elsewhere
 * (a manager who could edit part of a record could still write anything into
 * that part, so a boundary drawn there would be a promise the product cannot
 * keep) and this card states its consequence rather than re-deciding it.
 *
 * ## The Manage sentence
 *
 * It says the other person can add, change and remove entries, including ones
 * the owner entered themselves. That clause is the whole of what separates
 * this level from the one below it, and softening it — "manage the record",
 * "help keep it up to date" — would be describing a delete button as
 * housekeeping. What Manage does NOT reach is said in the same breath, because
 * a fence nobody is told about is not reassurance, it is a surprise waiting.
 *
 * Errors are named, not generic. "No account with that name" and "that person
 * already has access" are different situations with different next steps, and
 * the server publishes a stable `meta.errorCode` for each precisely so this
 * card does not have to read prose to tell them apart.
 */
export function GrantInviteCard() {
  const { t } = useTranslations();
  const invite = useInviteGrant();
  const ownerTimezone = useInvitationOwnerTimezone();
  const [identifier, setIdentifier] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  // READ preselected. The narrower level is the one somebody should have to
  // choose their way out of, not into.
  const [access, setAccess] = useState<GrantAccessLevel>("READ");
  // Nothing preselected: neither "the entire record" nor "only sections" is
  // chosen until the owner picks one. `null` is that unset state, and it blocks
  // the form — a whole-record grant is a real decision, not the thing that
  // happens when somebody leaves the fieldset alone.
  const [narrowed, setNarrowed] = useState<boolean | null>(null);
  const [sections, setSections] = useState<ShareDomain[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [invited, setInvited] = useState<string | null>(null);

  // Cycle tracking is offered as a section only to somebody who tracks it.
  // Listing it otherwise would put a subject on the consent screen that has no
  // data behind it and, for many accounts, no relevance either.
  const tracksCycle = useModuleEnabled("cycle");
  const offered = SHARE_DOMAINS.filter(
    (domain) => domain !== "cycle" || tracksCycle,
  );

  const choice = resolveInviteScope({ access, narrowed, sections });

  const chooseAccess = (level: GrantAccessLevel) => {
    setAccess(level);
    setError(null);
  };

  const toggleSection = (domain: ShareDomain) => {
    setSections((current) =>
      current.includes(domain)
        ? current.filter((d) => d !== domain)
        : [...current, domain],
    );
    setError(null);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = identifier.trim();
    if (value.length === 0 || choice.blocked) return;
    setError(null);
    setInvited(null);
    invite.mutate(
      {
        identifier: value,
        access,
        scope: choice.scope,
        expiresAt: endOfDayIso(expiresOn, ownerTimezone),
      },
      {
        onSuccess: (grant) => {
          setIdentifier("");
          setExpiresOn("");
          setAccess("READ");
          setNarrowed(null);
          setSections([]);
          setInvited(grant.account.username);
        },
        onError: (err) => setError(t(inviteErrorKey(err))),
      },
    );
  };

  return (
    <SettingsCard data-slot="grant-invite-card">
      <SettingsCardHeader
        icon={UserPlus}
        title={t("recordSharing.invite.title")}
        // A sharing invitation carries no link and nothing is e-mailed: the
        // person accepts it from inside their own session. Said here, at the
        // top of the card, so an inviter never goes looking for a link to
        // send — the invite-link surface is Admin → Invites, and it is a
        // different thing entirely.
        description={`${t("recordSharing.invite.description")} ${t(
          "recordSharing.invite.needsAccount",
        )}`}
      />
      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="grant-invite-identifier">
            {t("recordSharing.invite.identifierLabel")}
          </Label>
          <Input
            id="grant-invite-identifier"
            data-slot="grant-invite-identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={t("recordSharing.invite.identifierPlaceholder")}
            autoComplete="off"
            maxLength={255}
          />
          <p className="text-muted-foreground text-xs">
            {t("recordSharing.invite.identifierHint")}
          </p>
        </div>
        <fieldset className="space-y-1.5" data-slot="grant-invite-access">
          {/* The `Label` primitive is a `<label>` and cannot name a group, so
              the legend mirrors its type and its trailing colon by hand rather
              than mislabelling one radio as the heading of both. */}
          <legend className="pl-1 text-sm leading-none font-medium after:content-[':']">
            {t("recordSharing.invite.accessLegend")}
          </legend>
          <div className="space-y-2">
            <AccessOption
              level="READ"
              selected={access === "READ"}
              onSelect={() => chooseAccess("READ")}
              label={t("recordSharing.invite.accessReadLabel")}
              capability={t("recordSharing.invite.accessReadCapability")}
            />
            <AccessOption
              level="WRITE"
              selected={access === "WRITE"}
              onSelect={() => chooseAccess("WRITE")}
              label={t("recordSharing.invite.accessWriteLabel")}
              capability={t("recordSharing.invite.accessWriteCapability")}
              detail={t("recordSharing.invite.accessWriteDetail")}
            />
            <AccessOption
              level="MANAGE"
              selected={access === "MANAGE"}
              onSelect={() => chooseAccess("MANAGE")}
              label={t("recordSharing.invite.accessManageLabel")}
              capability={t("recordSharing.invite.accessManageCapability")}
              detail={t("recordSharing.invite.accessManageDetail")}
            />
          </div>
          {choice.mode === "manage" && (
            <p
              data-slot="grant-invite-manage-stepup"
              className="text-muted-foreground pl-1 text-xs"
            >
              {t("recordSharing.invite.manageStepUpNote")}
            </p>
          )}
        </fieldset>

        {choice.mode === "manage" ? (
          // Not a hidden section and not a disabled one: the question does not
          // apply at this level, so what is rendered is the answer to it.
          <p
            data-slot="grant-invite-scope-manage"
            className="text-muted-foreground pl-1 text-xs"
          >
            {t("recordSharing.invite.scopeManageNote")}
          </p>
        ) : (
          <fieldset className="space-y-1.5" data-slot="grant-invite-scope">
            <legend className="pl-1 text-sm leading-none font-medium after:content-[':']">
              {t("recordSharing.invite.scopeLegend")}
            </legend>
            <div className="space-y-2">
              <ScopeOption
                mode="all"
                selected={narrowed === false}
                onSelect={() => {
                  setNarrowed(false);
                  setError(null);
                }}
                label={t("recordSharing.invite.scopeAllLabel")}
                capability={t("recordSharing.invite.scopeAllCapability")}
              />
              <ScopeOption
                mode="some"
                selected={narrowed === true}
                onSelect={() => {
                  setNarrowed(true);
                  setError(null);
                }}
                label={t("recordSharing.invite.scopeSomeLabel")}
                capability={t("recordSharing.invite.scopeSomeCapability")}
              />
            </div>
            {choice.mode === "unset" && (
              // Nothing chosen: say what the two options decide, rather than
              // sending a request or silently defaulting to the whole record.
              <p
                data-slot="grant-invite-scope-choose"
                className="text-muted-foreground pl-1 text-xs"
              >
                {t("recordSharing.invite.scopeChooseHint")}
              </p>
            )}
            {choice.mode === "pick" && (
              <div
                data-slot="grant-invite-sections"
                className="border-border space-y-3 rounded-md border p-3"
              >
                {/* Both limits are stated ABOVE the checkboxes. A caveat under
                    a control somebody has already ticked is a disclaimer; the
                    same sentence above it is part of the decision. */}
                <div className="text-muted-foreground space-y-1 text-xs">
                  <p data-slot="grant-invite-scope-leak">
                    {t("recordSharing.invite.scopeLeakNote")}
                  </p>
                  <p data-slot="grant-invite-scope-aggregates">
                    {t("recordSharing.invite.scopeAggregateNote")}
                  </p>
                </div>
                <div className="space-y-2">
                  {offered.map((domain) => (
                    <SectionOption
                      key={domain}
                      domain={domain}
                      checked={sections.includes(domain)}
                      onToggle={() => toggleSection(domain)}
                      label={t(`recordSharing.section.${domain}.label`)}
                      detail={t(`recordSharing.section.${domain}.detail`)}
                      // A document can hold a letter, a scan, a whole file
                      // somebody else wrote. It is the one section whose name
                      // does not bound what is inside it, so it says so.
                      warning={
                        domain === "documents"
                          ? t("recordSharing.invite.scopeDocumentsNote")
                          : undefined
                      }
                    />
                  ))}
                </div>
                {choice.blocked && (
                  <p
                    data-slot="grant-invite-scope-empty"
                    className="text-muted-foreground text-xs"
                  >
                    {t("recordSharing.invite.scopeEmptyHint")}
                  </p>
                )}
              </div>
            )}
          </fieldset>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="grant-invite-expires">
            {t("recordSharing.invite.expiresLabel")}
          </Label>
          <DateField
            id="grant-invite-expires"
            // `data-slot` rides `{...rest}` onto `DateField`'s HIDDEN mirror
            // input — the one that carries the ISO value for a native submit.
            // A browser test that targeted it found an invisible element and a
            // `fill()` that typed into nothing. `data-testid` is the
            // primitive's own affordance for the VISIBLE overlay, which is the
            // control a person actually types into, so the browser test uses
            // that and the slot stays where every other caller expects it.
            data-slot="grant-invite-expires"
            data-testid="grant-invite-expires-input"
            value={expiresOn}
            min={tomorrowIso(ownerTimezone)}
            onChange={setExpiresOn}
            aria-describedby="grant-invite-expires-hint"
          />
          <p
            id="grant-invite-expires-hint"
            className="text-muted-foreground text-xs"
          >
            {t("recordSharing.invite.expiresHint")}
          </p>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {invited && (
          <p role="status" className="text-sm">
            {t("recordSharing.invite.sent", { name: invited })}
          </p>
        )}
        <SettingsCardActions>
          <Button
            type="submit"
            size="sm"
            className="min-h-11 sm:min-h-9"
            data-slot="grant-invite-submit"
            // A narrowed invitation with nothing ticked would be a grant that
            // opens nothing, which the server refuses. The button is inert and
            // the sentence above says why, rather than sending a request whose
            // only purpose is to come back as an error.
            disabled={
              invite.isPending ||
              identifier.trim().length === 0 ||
              choice.blocked
            }
          >
            {invite.isPending
              ? t("recordSharing.invite.submitting")
              : t("recordSharing.invite.submit")}
          </Button>
        </SettingsCardActions>
      </form>
    </SettingsCard>
  );
}

/** The three levels an invitation can carry, as the client names them. */
export type GrantAccessLevel = "READ" | "WRITE" | "MANAGE";

/** What the form is asking, and what it would send if asked to send now. */
export interface InviteScopeChoice {
  /**
   * Which of the three shapes the second question takes: the collapsed line
   * that answers it for Manage, the whole record, or the section list.
   */
  mode: "manage" | "unset" | "all" | "pick";
  /** Exactly what goes on the wire as `scope`. */
  scope: ShareDomain[] | null;
  /** Is the form in a state that must not be sent. */
  blocked: boolean;
}

/**
 * The whole of what the form decides, as one pure function.
 *
 * Exported and pure for the same reason `endOfDayIso` and `revokeBody` are:
 * the component's interactive states are not reachable from a static render,
 * so a click-free suite can prove the copy exists and nothing about what the
 * copy leads to. This is the part worth proving.
 *
 * Two properties it holds, and both are safety rather than tidiness:
 *
 *   * **A Manage invitation never carries a scope, whatever is ticked.** The
 *     checkbox state deliberately survives a trip through the Manage option —
 *     somebody who picked three sections, read the Manage sentence and went
 *     back should find their three sections still ticked — so "the sections
 *     are not on screen" is not the same as "the sections are not in state".
 *     The level is what decides, and it decides here rather than at the call
 *     site. The server refuses the pair too; this is what stops the form ever
 *     asking.
 *   * **The sections travel in reading order.** The state is a click log, and
 *     two owners who ticked the same three sections in a different sequence
 *     would otherwise write rows that look different and mean the same.
 */
export function resolveInviteScope({
  access,
  narrowed,
  sections,
}: {
  access: GrantAccessLevel;
  narrowed: boolean | null;
  sections: ShareDomain[];
}): InviteScopeChoice {
  if (access === "MANAGE") {
    return { mode: "manage", scope: null, blocked: false };
  }
  // Nothing chosen yet. This is NOT the whole-record default: scope-absent is
  // read by the wire as "the entire record" (the pre-v1.37.0 contract), so an
  // unset UI must block rather than fall through to it. The whole-record grant
  // is only ever the explicit "all" choice below.
  if (narrowed === null) return { mode: "unset", scope: null, blocked: true };
  if (!narrowed) return { mode: "all", scope: null, blocked: false };
  const picked = SHARE_DOMAINS.filter((domain) => sections.includes(domain));
  // A narrowed invitation with nothing ticked is not a narrow grant, it is a
  // grant that opens nothing. The server refuses it; the form does not offer
  // to send it, and says why instead.
  return { mode: "pick", scope: picked, blocked: picked.length === 0 };
}

/**
 * One level, with the one sentence that says what it actually does.
 *
 * The capability line is the part the owner is consenting to, so it stays
 * inline under the label rather than behind an icon — but it is one line, not a
 * wall. Where a level has more to say than fits on a line (the exact list WRITE
 * may add, the fence MANAGE does NOT reach), that detail rides an `InfoPopover`
 * at the option-heading height. The (i) sits OUTSIDE the `<label>` on purpose:
 * a button inside a label forwards its own tap to the label's control, so the
 * radio and the popover would fight for the same click (the same reason
 * `SectionOption` avoids the wrapping label). Muted, `text-xs` — the meta floor
 * per UI-STANDARDS §3.
 */
function AccessOption({
  level,
  selected,
  onSelect,
  label,
  capability,
  detail,
}: {
  level: GrantAccessLevel;
  selected: boolean;
  onSelect: () => void;
  label: string;
  capability: string;
  /** The full enumeration, shown behind the (i) when a line is not enough. */
  detail?: string;
}) {
  const id = `grant-invite-access-${level}`;
  return (
    <div
      data-slot="grant-invite-access-option"
      data-access={level}
      data-selected={selected ? "true" : "false"}
      className={optionClass(selected)}
    >
      <label htmlFor={id} className="flex flex-1 cursor-pointer items-start">
        <input
          id={id}
          type="radio"
          name="grant-invite-access"
          value={level}
          checked={selected}
          onChange={onSelect}
          className="sr-only"
        />
        <span className="space-y-1">
          <span className="text-foreground block text-sm font-medium">
            {label}
          </span>
          <span className="text-muted-foreground block text-xs">
            {capability}
          </span>
        </span>
      </label>
      {detail ? (
        <InfoPopover
          content={detail}
          label={label}
          bodyDataSlot="grant-invite-access-detail"
        />
      ) : null}
    </div>
  );
}

/**
 * Whole record, or the sections you pick.
 *
 * Deliberately the same control as the level above it: the two questions are
 * asked in the same voice, so nothing about the second one reads as advanced
 * or as an exception. The radio is what makes narrowing a branch rather than a
 * checkbox somebody might leave half-answered.
 */
function ScopeOption({
  mode,
  selected,
  onSelect,
  label,
  capability,
}: {
  mode: "all" | "some";
  selected: boolean;
  onSelect: () => void;
  label: string;
  capability: string;
}) {
  return (
    <label
      data-slot="grant-invite-scope-option"
      data-scope={mode}
      data-selected={selected ? "true" : "false"}
      className={optionClass(selected)}
    >
      <input
        type="radio"
        name="grant-invite-scope"
        value={mode}
        checked={selected}
        onChange={onSelect}
        className="sr-only"
      />
      <span className="space-y-1">
        <span className="text-foreground block text-sm font-medium">
          {label}
        </span>
        <span className="text-muted-foreground block text-xs">
          {capability}
        </span>
      </span>
    </label>
  );
}

/**
 * One section of the record, with the sentence that says what is in it.
 *
 * A real checkbox rather than a chip or a toggle: eight independent yes/no
 * answers are what a checkbox list is for, and the eight sentences are what
 * make the names mean something to somebody who did not draw the boundaries.
 */
function SectionOption({
  domain,
  checked,
  onToggle,
  label,
  detail,
  warning,
}: {
  domain: ShareDomain;
  checked: boolean;
  onToggle: () => void;
  label: string;
  detail: string;
  warning?: string;
}) {
  // Explicit association rather than a wrapping `<label>`: the primitive is a
  // Radix checkbox, which renders a `<button>`. A button is labelable, so an
  // implicit label would forward its own click to it and a tap on the box
  // itself could toggle twice. `htmlFor` gives the sentence a hit target
  // without that.
  const id = `grant-invite-section-${domain}`;
  return (
    <div
      data-slot="grant-invite-section"
      data-section={domain}
      data-checked={checked ? "true" : "false"}
      className="hover:bg-muted/40 has-[:focus-visible]:ring-ring/50 flex min-h-11 items-start gap-3 rounded-md p-1.5 transition-colors has-[:focus-visible]:ring-2"
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onToggle}
        className="mt-0.5"
      />
      <label htmlFor={id} className="cursor-pointer space-y-0.5">
        <span className="text-foreground block text-sm font-medium">
          {label}
        </span>
        <span className="text-muted-foreground block text-xs">{detail}</span>
        {warning && (
          <span
            data-slot="grant-invite-section-warning"
            className="text-muted-foreground block text-xs"
          >
            {warning}
          </span>
        )}
      </label>
    </div>
  );
}

/**
 * The shared look of a choosable option row.
 *
 * The radio itself is `sr-only`, so the browser's own focus ring lands on a
 * zero-size box: keyboard focus moved through the fieldset with nothing
 * visible moving with it. WCAG 2.4.7, on the screen where somebody decides who
 * may write into their health record. The label wears the ring instead, on the
 * same `ring-ring/50 ring-2` token the capture picker's options use — and both
 * fieldsets share this function so the second one cannot lose it.
 */
function optionClass(selected: boolean): string {
  return [
    "flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
    "has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-2",
    selected
      ? "border-primary bg-primary/5"
      : "border-border hover:bg-muted/40",
  ].join(" ");
}

/**
 * The chosen day, as the instant access stops.
 *
 * The shared date field yields a bare `YYYY-MM-DD`, and the grant's
 * `expiresAt` is checked live against `now` on every request. Anchoring at the
 * end of the chosen day in the owner's timezone makes "until the 30th" mean
 * the owner's entire 30th, regardless of the browser's zone. Empty means no
 * lapse date, which is the default and stays the common case.
 */
export function endOfDayIso(day: string, timeZone: string): string | null {
  if (day.length === 0) return null;
  if (!isValidTimezone(timeZone)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [, year, month, date] = match;
  const calendarDate = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(date)),
  );
  if (
    calendarDate.getUTCFullYear() !== Number(year) ||
    calendarDate.getUTCMonth() !== Number(month) - 1 ||
    calendarDate.getUTCDate() !== Number(date)
  ) {
    return null;
  }
  const end = zonedWallClockToUtc(
    {
      year: Number(year),
      month: Number(month),
      day: Number(date),
      hour: 23,
      minute: 59,
      second: 59,
    },
    timeZone,
  );
  return new Date(end.getTime() + 999).toISOString();
}

/** The earliest day worth offering: a grant that lapses today confers nothing. */
function tomorrowIso(timeZone: string): string {
  const zone = isValidTimezone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  const today = wallClockInTz(new Date(), zone);
  const tomorrow = new Date(
    Date.UTC(today.year, today.month - 1, today.day) + 86_400_000,
  );
  return `${tomorrow.getUTCFullYear()}-${String(
    tomorrow.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(tomorrow.getUTCDate()).padStart(2, "0")}`;
}

function useInvitationOwnerTimezone(): string {
  const hasQueryClient = useQueryClientMounted();
  if (!hasQueryClient) return DEFAULT_TIMEZONE;
  // The invitation surface is only available in the owner's own record. Its
  // profile timezone therefore defines the calendar day an expiry names.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { user } = useAuth();
  return isValidTimezone(user?.timezone ?? "")
    ? (user?.timezone as string)
    : DEFAULT_TIMEZONE;
}

/**
 * The message for a refused invitation.
 *
 * Branches on the stable `meta.errorCode` rather than the status alone: a 422
 * covers both a malformed identifier and an invitation somebody addressed to
 * themselves, and telling those two apart is the difference between "fix the
 * field" and "you already have your own record".
 */
export function inviteErrorKey(err: unknown): string {
  // Nothing that is not an `ApiError` ever reached a response, so no
  // invitation was refused — the request did not arrive. Said as its own case
  // because "the invitation could not be sent" invites somebody to change the
  // form, and the form is fine. The typed identifier, the level and the ticked
  // sections all survive a failed mutation, so the retry is the same button.
  if (!(err instanceof ApiError)) return "recordSharing.invite.errorOffline";

  const code =
    typeof err.meta?.errorCode === "string" ? err.meta.errorCode : null;
  switch (code) {
    case "sharing.invite.self":
      return "recordSharing.invite.errorSelf";
    case "sharing.invite.duplicate":
      return "recordSharing.invite.errorDuplicate";
    case "sharing.invite.invalid":
      return "recordSharing.invite.errorInvalid";
    case "sharing.invite.invalid_scope":
      return "recordSharing.invite.errorScope";
    // The decided consequence of gating Manage on a fresh second factor: the
    // step-up is cookie-only, so this reaches a native caller and nobody else.
    // Named rather than folded into the generic failure, because "use a
    // browser for this one" is a next step and "the invitation could not be
    // sent" is not.
    case "sharing.invite.manage_browser_only":
      return "recordSharing.invite.errorManageBrowserOnly";
    default:
      break;
  }
  if (err instanceof ApiError && err.status === 404) {
    return "recordSharing.invite.errorNoAccount";
  }
  if (err instanceof ApiError && err.status === 429) {
    return "recordSharing.invite.errorRateLimited";
  }
  // A 401 on a request that was authenticated enough to reach validation is
  // the step-up gate, not a lapsed session: the owner has a second factor and
  // has not proved it recently enough to hand somebody management of their
  // record. Said as the thing to do next.
  if (err instanceof ApiError && err.status === 401) {
    return "recordSharing.invite.errorStepUp";
  }
  return "recordSharing.invite.errorFailed";
}
