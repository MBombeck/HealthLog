# The "source stopped syncing" notification

When a source that delivers every day goes quiet, HealthLog tells you once:
"Apple Health has sent nothing since yesterday. Opening HealthLog once is
enough." It is on by default. Switch it off in **Settings > Notifications**,
under **Alerts** ("A source stopped syncing"), for every channel at once, or
per channel under **Notifications per channel** in the account menu.

## Why an iPhone needs it

iOS stops sending the app silent pushes and background Health deliveries
once the app is swiped away in the app switcher. The server's silent
catch-up request, sent after six quiet hours, cannot reach it then. A visible
notification still can, and opening the app once runs the upload and lets
iOS resume background delivery.

## When a source counts as quiet

Each source is judged against its own last 14 days, never against a fixed
schedule:

- Only a source that delivered on at least 10 of those days is watched. A
  scale used now and then, or a phone left in a drawer, never is.
- It counts as quiet after 24 hours without data, or twice its usual gap
  between deliveries if that is longer. Rings, watches and scales that upload
  through their own phone app (Oura, WHOOP, Garmin, Withings) get two days at
  least, because a day without opening that app is ordinary.
- An iPhone is judged per device, by when the server last accepted Apple
  Health data from it of a kind iOS hands over in the background: heart
  rate, steps, sleep and the other vital signs. Energy, floors, distance and
  VO2 max sync only while the app is open and never count either way.
- Imports you upload by hand are never watched.

The integrations page uses the same rule: a quiet source's card says since
when, and the Apple Health card lists each quiet iPhone.

## Built not to nag

- One notification per quiet spell. The next delivery ends it, and only the
  next quiet spell is told again.
- Only between 09:00 and 20:00 in your time zone; a spell that starts at
  night is told in the morning.
- At most one such notification a day, whatever else went quiet.
- Nothing while another iPhone of the account still delivers Apple Health
  data.

A tap opens the source's card under **Settings > Integrations**. After an
update the server first learns each iPhone's rhythm from its new uploads, so
the first notification for a phone can come about ten days later.
