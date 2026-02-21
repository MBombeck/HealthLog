# Medication Status Badges Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show real-time color-coded status badges on medication cards (green→yellow→orange→missed) with configurable thresholds in admin settings, and make the reminder worker respect those thresholds before creating missed events.

**Architecture:** Two new fields in `AppSettings` store the late/missed thresholds in minutes. A new public API endpoint exposes them to the client. The medication card computes the current status client-side using a 60-second interval timer. The reminder worker reads thresholds from the DB and only creates missed events after the full grace period.

**Tech Stack:** Prisma migration, Next.js API routes, React (TanStack Query, useState/useEffect interval), Dracula CSS tokens.

---

### Task 1: Add threshold fields to AppSettings schema

**Files:**
- Modify: `prisma/schema.prisma:254-275`

**Step 1: Add the two new fields to AppSettings model**

In `prisma/schema.prisma`, inside the `AppSettings` model, add before the closing brace and `@@map`:

```prisma
  // Medication reminder thresholds (minutes after windowEnd)
  reminderLateMinutes     Int @default(120) @map("reminder_late_minutes")
  reminderMissedMinutes   Int @default(240) @map("reminder_missed_minutes")
```

The full model should have these two lines right before `@@map("app_settings")`.

**Step 2: Generate and apply migration**

Run: `pnpm db:migrate --name add-reminder-thresholds`
Expected: Migration created and applied successfully.

**Step 3: Commit**

```bash
git add prisma/
git commit -m "feat: add reminder threshold fields to AppSettings schema"
```

---

### Task 2: Add settings helper to read thresholds

**Files:**
- Modify: `src/lib/app-settings.ts`

**Step 1: Add the helper function**

Append to `src/lib/app-settings.ts`:

```typescript
export interface ReminderThresholds {
  lateMinutes: number;
  missedMinutes: number;
}

export async function getReminderThresholds(): Promise<ReminderThresholds> {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        reminderLateMinutes: true,
        reminderMissedMinutes: true,
      },
    });

    return {
      lateMinutes: settings?.reminderLateMinutes ?? 120,
      missedMinutes: settings?.reminderMissedMinutes ?? 240,
    };
  } catch (error) {
    console.error("Failed to load reminder thresholds, using defaults:", error);
    return { lateMinutes: 120, missedMinutes: 240 };
  }
}
```

**Step 2: Commit**

```bash
git add src/lib/app-settings.ts
git commit -m "feat: add getReminderThresholds helper"
```

---

### Task 3: Expose thresholds in admin settings API

**Files:**
- Modify: `src/app/api/admin/settings/route.ts`

**Step 1: Add thresholds to GET response**

In the GET handler, add to the `apiSuccess({...})` object (after the `bugReportConfigured` line):

```typescript
    reminderLateMinutes: settings?.reminderLateMinutes ?? 120,
    reminderMissedMinutes: settings?.reminderMissedMinutes ?? 240,
```

**Step 2: Add thresholds to PUT handler**

In the PUT handler, add validation blocks after the `clearBugReportToken` block (before the `if (Object.keys(updates).length === 0)` check):

```typescript
    if (typeof body.reminderLateMinutes === "number") {
      if (body.reminderLateMinutes < 15 || body.reminderLateMinutes > 480) {
        return apiError("Spät-Schwellenwert muss zwischen 15 und 480 Minuten liegen", 422);
      }
      updates.reminderLateMinutes = body.reminderLateMinutes;
      auditDetails.reminderLateMinutes = body.reminderLateMinutes;
    }
    if (typeof body.reminderMissedMinutes === "number") {
      if (body.reminderMissedMinutes < 30 || body.reminderMissedMinutes > 720) {
        return apiError("Verpasst-Schwellenwert muss zwischen 30 und 720 Minuten liegen", 422);
      }
      updates.reminderMissedMinutes = body.reminderMissedMinutes;
      auditDetails.reminderMissedMinutes = body.reminderMissedMinutes;
    }
```

Also add the two fields to the PUT response `apiSuccess({...})` object:

```typescript
      reminderLateMinutes: settings.reminderLateMinutes,
      reminderMissedMinutes: settings.reminderMissedMinutes,
```

**Step 3: Commit**

```bash
git add src/app/api/admin/settings/route.ts
git commit -m "feat: expose reminder thresholds in admin settings API"
```

---

### Task 4: Create public API endpoint for thresholds

The medication card needs the thresholds client-side. Create a lightweight authenticated endpoint.

**Files:**
- Create: `src/app/api/settings/reminder-thresholds/route.ts`

**Step 1: Create the route**

```typescript
import { getSession } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getReminderThresholds } from "@/lib/app-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return apiError("Nicht angemeldet", 401);

  const thresholds = await getReminderThresholds();
  return apiSuccess(thresholds);
}
```

**Step 2: Commit**

```bash
git add src/app/api/settings/reminder-thresholds/route.ts
git commit -m "feat: add public API endpoint for reminder thresholds"
```

---

### Task 5: Add admin UI section for thresholds

**Files:**
- Modify: `src/app/admin/page.tsx`
- Modify: `messages/de.json`
- Modify: `messages/en.json`

**Step 1: Add i18n strings**

In `messages/de.json`, inside the `"admin"` object (after the `"authPasskeyDelete"` line), add:

```json
    "medicationReminders": "Medikamentenerinnerungen",
    "medicationRemindersDescription": "Schwellenwerte für die Farbübergänge der Erinnerungs-Badges auf den Medikamentenkarten.",
    "reminderLateMinutes": "Spät-Schwellenwert (Minuten)",
    "reminderLateMinutesDescription": "Minuten nach Fenster-Ende bis der Badge von Gelb auf Orange wechselt.",
    "reminderMissedMinutes": "Verpasst-Schwellenwert (Minuten)",
    "reminderMissedMinutesDescription": "Minuten nach Fenster-Ende bis die Einnahme als verpasst gilt.",
    "reminderThresholdsSave": "Schwellenwerte speichern"
```

In `messages/en.json`, inside the `"admin"` object at the same position, add:

```json
    "medicationReminders": "Medication Reminders",
    "medicationRemindersDescription": "Thresholds for the color transitions of reminder badges on medication cards.",
    "reminderLateMinutes": "Late threshold (minutes)",
    "reminderLateMinutesDescription": "Minutes after window end until badge changes from yellow to orange.",
    "reminderMissedMinutes": "Missed threshold (minutes)",
    "reminderMissedMinutesDescription": "Minutes after window end until intake is marked as missed.",
    "reminderThresholdsSave": "Save thresholds"
```

**Step 2: Add fields to AdminSettings interface**

In `src/app/admin/page.tsx`, add to the `AdminSettings` interface (after `bugReportConfigured`):

```typescript
  reminderLateMinutes: number;
  reminderMissedMinutes: number;
```

**Step 3: Add section ID**

In the `adminSections` array, add after the `bugReport` entry:

```typescript
    { id: "section-admin-reminders", label: t("admin.medicationReminders") },
```

**Step 4: Pass the new section ID to AppSettingsSection**

Update the `ids` prop type in `AppSettingsSection` to include `reminders: string`, and pass it from the parent:

```typescript
ids={{
  general: "section-admin-general",
  services: "section-admin-services",
  monitoring: "section-admin-monitoring",
  bugReport: "section-admin-bugreport",
  reminders: "section-admin-reminders",
}}
```

**Step 5: Add draft state and UI to AppSettingsSection**

Add two new state variables at the top of `AppSettingsSection`:

```typescript
const [reminderLateDraft, setReminderLateDraft] = useState<number | null>(null);
const [reminderMissedDraft, setReminderMissedDraft] = useState<number | null>(null);
```

Add the UI section at the end of AppSettingsSection's return JSX (after the Bug Report card, before the closing fragment). Use the existing card pattern:

```tsx
{/* ── Medication Reminders ── */}
<Card id={ids.reminders}>
  <CardHeader>
    <CardTitle className="flex items-center gap-2">
      <Clock className="h-5 w-5" />
      {t("admin.medicationReminders")}
    </CardTitle>
    <p className="text-muted-foreground text-sm">
      {t("admin.medicationRemindersDescription")}
    </p>
  </CardHeader>
  <CardContent className="space-y-4">
    <div className="space-y-2">
      <Label>{t("admin.reminderLateMinutes")}</Label>
      <p className="text-muted-foreground text-xs">
        {t("admin.reminderLateMinutesDescription")}
      </p>
      <Input
        type="number"
        min={15}
        max={480}
        value={reminderLateDraft ?? settings?.reminderLateMinutes ?? 120}
        onChange={(e) => setReminderLateDraft(Number(e.target.value))}
        className="w-32"
      />
    </div>
    <div className="space-y-2">
      <Label>{t("admin.reminderMissedMinutes")}</Label>
      <p className="text-muted-foreground text-xs">
        {t("admin.reminderMissedMinutesDescription")}
      </p>
      <Input
        type="number"
        min={30}
        max={720}
        value={reminderMissedDraft ?? settings?.reminderMissedMinutes ?? 240}
        onChange={(e) => setReminderMissedDraft(Number(e.target.value))}
        className="w-32"
      />
    </div>
    <Button
      size="sm"
      onClick={() => {
        updateSettings.mutate({
          ...(reminderLateDraft != null && { reminderLateMinutes: reminderLateDraft }),
          ...(reminderMissedDraft != null && { reminderMissedMinutes: reminderMissedDraft }),
        });
        setReminderLateDraft(null);
        setReminderMissedDraft(null);
      }}
      disabled={updateSettings.isPending || (reminderLateDraft == null && reminderMissedDraft == null)}
    >
      {t("admin.reminderThresholdsSave")}
    </Button>
  </CardContent>
</Card>
```

Ensure the `Clock` icon from `lucide-react` is already imported (it is used elsewhere in the admin page — verify, and add to imports if not).

**Step 6: Commit**

```bash
git add src/app/admin/page.tsx messages/de.json messages/en.json
git commit -m "feat: add medication reminder thresholds section to admin UI"
```

---

### Task 6: Add real-time status badge to medication card

**Files:**
- Modify: `src/components/medications/medication-card.tsx`

**Step 1: Add thresholds query and interval timer**

Add a TanStack Query to fetch the thresholds (alongside the existing compliance query). Add a state variable that ticks every 60 seconds to force re-render:

```typescript
const [, setTick] = useState(0);

const { data: thresholds } = useQuery({
  queryKey: ["settings", "reminder-thresholds"],
  queryFn: async () => {
    const res = await fetch("/api/settings/reminder-thresholds");
    if (!res.ok) return null;
    const json = await res.json();
    return json.data as { lateMinutes: number; missedMinutes: number };
  },
  staleTime: 5 * 60 * 1000, // 5 minutes - thresholds rarely change
});
```

Add a `useEffect` for the interval timer (import `useEffect` from React):

```typescript
useEffect(() => {
  const interval = setInterval(() => setTick((t) => t + 1), 60_000);
  return () => clearInterval(interval);
}, []);
```

**Step 2: Add status computation function**

Add this function inside the component (after imports, before the return):

```typescript
type MedicationWindowStatus = "in_window" | "late" | "very_late" | null;

function getWindowStatus(
  schedule: Schedule,
  nowBerlin: Date,
  lateMinutes: number,
  missedMinutes: number,
): MedicationWindowStatus {
  const nowMins = nowBerlin.getHours() * 60 + nowBerlin.getMinutes();
  const startMins = parseTimeToMinutes(schedule.windowStart);
  let endMins = parseTimeToMinutes(schedule.windowEnd);

  // Handle overnight windows
  if (endMins <= startMins) endMins += 24 * 60;
  const adjustedNow = nowMins < startMins && endMins > 24 * 60
    ? nowMins + 24 * 60
    : nowMins;

  // Currently in window
  if (adjustedNow >= startMins && adjustedNow <= endMins) return "in_window";

  // Past window end: check late thresholds
  const minutesPastEnd = adjustedNow - endMins;
  if (minutesPastEnd > 0 && minutesPastEnd <= lateMinutes) return "late";
  if (minutesPastEnd > lateMinutes && minutesPastEnd <= missedMinutes) return "very_late";

  return null; // Either before window or past missed threshold
}
```

**Step 3: Compute current status for active schedule**

After the `nextSchedule` computation, add:

```typescript
const lateMinutes = thresholds?.lateMinutes ?? 120;
const missedMinutes = thresholds?.missedMinutes ?? 240;

// Find the current or most recently passed schedule that's still in grace period
const currentWindowStatus = medication.active
  ? sortedSchedules.reduce<{ status: MedicationWindowStatus; schedule: Schedule | null }>(
      (best, s) => {
        const status = getWindowStatus(s, nowBerlin, lateMinutes, missedMinutes);
        if (!status) return best;
        // Prefer "in_window" > "late" > "very_late"
        const priority = { in_window: 3, late: 2, very_late: 1 };
        if (!best.status || priority[status] > priority[best.status]) {
          return { status, schedule: s };
        }
        return best;
      },
      { status: null, schedule: null },
    )
  : { status: null, schedule: null };
```

**Step 4: Add the status badge to the JSX**

Add this right before the `{/* Next schedule badge */}` section, inside `<CardContent>`:

```tsx
{currentWindowStatus.status && (
  <Badge
    variant="outline"
    className={
      currentWindowStatus.status === "in_window"
        ? "border-dracula-green/40 bg-dracula-green/15 text-dracula-green gap-1"
        : currentWindowStatus.status === "late"
          ? "border-dracula-yellow/40 bg-dracula-yellow/15 text-dracula-yellow gap-1"
          : "border-dracula-orange/40 bg-dracula-orange/15 text-dracula-orange gap-1"
    }
  >
    <Clock className="h-3 w-3" />
    {currentWindowStatus.status === "in_window"
      ? "Jetzt einnehmen"
      : currentWindowStatus.status === "late"
        ? "Überfällig"
        : "Stark überfällig"}
  </Badge>
)}
```

**Step 5: Commit**

```bash
git add src/components/medications/medication-card.tsx
git commit -m "feat: add real-time status badge to medication card"
```

---

### Task 7: Update reminder worker to use configurable thresholds

**Files:**
- Modify: `src/lib/jobs/reminder-worker.ts`

**Step 1: Import and use thresholds**

The reminder worker creates its own PrismaClient (not the shared singleton). Read thresholds directly from the DB at the start of `handleReminderCheck`:

At the top of `handleReminderCheck`, after `const now = new Date();`, add:

```typescript
    // Read configurable thresholds
    const appSettings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        reminderMissedMinutes: true,
      },
    });
    const missedMinutes = appSettings?.reminderMissedMinutes ?? 240;
```

**Step 2: Change the window-end check to use missedMinutes threshold**

Replace the current check in `passedSchedules` filter:

```typescript
        // Check if past window end + missed threshold (full grace period expired)
        const endMins = parseTimeToMinutes(schedule.windowEnd);
        const currentMins = parseTimeToMinutes(currentTime);
        if (currentMins <= endMins + missedMinutes) return false;
```

Wait — the current check uses string comparison `currentTime <= schedule.windowEnd`. We need to convert to minutes for the threshold math. Also import `parseTimeToMinutes` or define it locally.

Add this helper at the top of the file (after the imports, before `const DATABASE_URL`):

```typescript
function parseTimeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}
```

Then update the `passedSchedules` filter to use minutes-based comparison:

Replace:
```typescript
        // Check if past window end
        if (currentTime <= schedule.windowEnd) return false;
```

With:
```typescript
        // Check if past window end + full missed threshold
        const endMins = parseTimeToMinutes(schedule.windowEnd);
        const currentMins = parseTimeToMinutes(currentTime);
        if (currentMins <= endMins + missedMinutes) return false;
```

**Step 3: Commit**

```bash
git add src/lib/jobs/reminder-worker.ts
git commit -m "feat: reminder worker uses configurable missed threshold"
```

---

### Task 8: Update compliance classification to use thresholds

**Files:**
- Modify: `src/lib/analytics/compliance.ts`

**Step 1: Make classifyIntakeTiming accept configurable thresholds**

Update the function signature to accept optional threshold parameters:

```typescript
export function classifyIntakeTiming(
  takenAt: Date | null,
  windowStart: string,
  windowEnd: string,
  scheduledDate: Date,
  options?: { lateMinutes?: number },
): IntakeTimingClass {
```

Replace the hardcoded `2 * 60 * 60 * 1000` late tolerance:

```typescript
  const lateTolerance = (options?.lateMinutes ?? 120) * 60 * 1000;
  const lateEnd = new Date(end.getTime() + lateTolerance);
```

This keeps backward compatibility — existing callers without options still get 120-minute defaults.

**Step 2: Commit**

```bash
git add src/lib/analytics/compliance.ts
git commit -m "feat: compliance classification supports configurable late threshold"
```

---

### Task 9: Verify and test

**Step 1: Run type check**

Run: `pnpm typecheck 2>&1 | grep -v "insights/\|@/generated"`
Expected: No new errors from modified files.

**Step 2: Run tests**

Run: `pnpm test`
Expected: All existing tests pass (compliance tests use defaults).

**Step 3: Run lint**

Run: `pnpm lint`
Expected: No errors.

**Step 4: Manual verification checklist**

- [ ] Admin page shows "Medikamentenerinnerungen" section with two number inputs
- [ ] Changing thresholds and saving persists the values
- [ ] Medication card shows green badge when inside a time window
- [ ] Badge turns yellow after window end
- [ ] Badge turns orange after late threshold
- [ ] Badge disappears after missed threshold (missed event created by worker)
- [ ] Reminder worker only creates missed events after the full missed threshold

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: medication status badges with configurable thresholds"
```
