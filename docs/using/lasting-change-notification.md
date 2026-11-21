# The "lasting change" notification

HealthLog can tell you when one of your vitals has settled at a new level:
"Resting heart rate has stayed higher since 3 Nov." It is off until you
switch it on, per channel, under **Notifications** ("Lasting change in a
vital").

## What counts as a lasting change

The notification uses the same scan as the health status card on the
Insights overview. A vital qualifies only when its daily values stepped to a
new level and stayed there:

- the step is large against the vital's own day-to-day spread, and above a
  floor per vital (3 bpm for resting heart rate, 5 mmHg for systolic blood
  pressure, 1 kg for weight, and so on);
- the new level has held for at least ten days;
- a slow drift does not explain it better than a step.

A single high reading never qualifies. The vitals scanned are resting and
walking heart rate, pulse, heart rate variability, weight, body fat, blood
pressure, blood glucose, breathing rate, oxygen saturation and VO2 max, each
only while its module is on.

The notification says what changed and since when, and opens Insights. It
never says why, and it is not a diagnosis.

## Built not to nag

- It goes out in your local 10 o'clock hour, never at night.
- Only a fresh change is news: one that started within the last three weeks.
- Each change is sent once. A later push about the same vital in the same
  direction waits 60 days.
- At most one such notification a week.
- Nothing is sent while an illness episode is open: a resting heart rate that
  rises with a flu is expected, and you know you are ill.
