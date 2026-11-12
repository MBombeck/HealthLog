# Notifications — push channels for a self-host

HealthLog delivers reminders (medication doses, mood check-ins, personal
records) and a few operational alerts through a small cascade of push
channels. The single message to take away: **you do not need an Apple
Developer account or APNs to get push.** Five of the six channels are
free, work in the browser or in an app you already have, and cover every
platform a self-hoster runs. APNs is only for the native iOS app, and
even that you can build yourself (see the last section).

When an event fires, the dispatcher fans it out to every channel a user
has enabled, in a fixed order — APNs first, then Telegram, then ntfy,
then the generic webhook, then email, then Web Push as the universal
fallback (`src/lib/notifications/dispatcher.ts`). Each channel is
best-effort and independent: a user can enable one or several, and a
failure on one never blocks the others.

An APNs-less instance degrades gracefully. Nothing about push depends on
APNs being configured. Urgent events still surface everywhere it matters:
ntfy escalates them to max priority (`5`), Web Push raises urgency and
keeps the notification on screen until the user acts, and the webhook
carries the urgent flag for your own routing. APNs only adds the
Apple-platform exclusives the web cannot offer.

## TL;DR — which channel needs what

| Channel      | What it needs                                                             | Cost                           | Where it works                                                                                          |
| ------------ | ------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Web Push** | A VAPID keypair (one command, or paste into the admin panel)              | Free                           | Any modern desktop/Android browser; the installed PWA on iPhone (iOS 16.4+, after _Add to Home Screen_) |
| **Telegram** | A bot token from @BotFather + each user's chat ID                         | Free                           | Anywhere the Telegram app runs                                                                          |
| **ntfy**     | A topic on `ntfy.sh` or your own ntfy server                              | Free                           | The ntfy app (iOS/Android) or any browser                                                               |
| **Webhook**  | A URL you own (and optionally one custom header)                          | Free                           | Anywhere — you route the POST yourself                                                                  |
| **Email**    | An SMTP transport you operate or rent                                     | Free–cheap                     | Any mailbox                                                                                             |
| **APNs**     | An Apple Developer account + a `.p8` push key + your own signed iOS build | Apple Developer Program (paid) | A native iOS app you build and sign                                                                     |

Web Push is the recommended default — it needs no third-party account,
just a keypair you generate yourself once.

## Web Push (recommended default)

Web Push delivers notifications straight to a browser — desktop or
mobile — even when the HealthLog tab is closed, as long as the browser
or installed PWA is alive. It is the broadest-reach channel and the one
to set up first.

### 1. Generate and store a VAPID keypair

VAPID is the signing scheme that lets a push service trust your server.
You also choose a **subject** — a `mailto:` address the push service can
contact about your sender, e.g. `mailto:you@example.com`.

The server loads VAPID config from the database first and falls back to
environment variables (`src/lib/notifications/vapid-config.ts`). The admin
panel is the easiest path because it survives without touching `.env`.

**Admin panel — Generate keys (easiest).** Sign in as the admin user,
open `/admin`, and find the **Web Push VAPID** card
(`src/components/admin/web-push-vapid-section.tsx`). Click **Generate
keys**: the server mints a fresh keypair, stores the private key encrypted
at rest with your `ENCRYPTION_KEY`, seeds a placeholder subject, and fills
in the public key. Edit the subject to your real `mailto:` address and
save. The card shows a "configured" badge once all three fields are set —
no shell, no copy-paste.

> If a keypair already exists, **Generate keys** asks you to confirm before
> replacing it. Regenerating invalidates every existing browser
> subscription, so each device has to re-subscribe afterwards. Only
> regenerate when you mean to.

**Admin panel — paste an existing pair.** If you already have a keypair
(e.g. copied from another deployment), paste the public key, the private
key, and the subject into the same card and save instead of generating.

**CLI — generate a pair yourself.** You can also mint one with the bundled
`web-push` CLI and paste the result into the card or your `.env`:

```bash
npx web-push generate-vapid-keys
```

That prints a **public key** and a **private key** (both Base64URL).

### 2. Store the keys via environment variables (alternative)

If you would rather keep secrets out of the database, set them in `.env` /
the compose `environment:` block instead:

```env
VAPID_PUBLIC_KEY="BElx...(public key)"
VAPID_PRIVATE_KEY="...(private key)"
VAPID_SUBJECT="mailto:you@example.com"
```

The database values win when both are present. These three names are the
only ones the loader reads.

### 3. Subscribe a device

Each user enables Web Push for their own browser from
`/settings/notifications` — the **Browser Push** card has a Subscribe
button, and a Test button to fire a one-off push once subscribed. The
browser prompts for notification permission on first subscribe; once
granted, that browser receives every enabled event.

## The PWA path — install to the Home Screen

Installing HealthLog as a PWA and enabling Web Push is the recommended
default for phones. It needs nothing from Apple and gives you, in
v1.18.4:

- **Reminders.** Medication doses, mood check-ins, and any other event
  the user has enabled, delivered to the installed app even when it is
  closed.
- **A reminder stays until you act on it.** It stays on screen until it
  is tapped or dismissed, or until the next reminder for the same dose
  replaces it.

### iPhone — Add to Home Screen first

Safari on iPhone supports Web Push only from **iOS 16.4 or newer**, and
only for a site that has been **installed to the Home Screen as a PWA**.
A regular Safari tab cannot subscribe. So on iPhone:

1. Open your HealthLog instance in Safari.
2. Tap the Share button, then **Add to Home Screen**.
3. Launch HealthLog from the new Home Screen icon (not from the Safari
   tab).
4. Open `/settings/notifications` inside that installed app and tap
   Subscribe; accept the permission prompt.

Android and desktop browsers have no such step — Subscribe and grant the
permission, and push works.

### The inherent limit

The installed PWA gets reminders, but it **cannot** show a native iOS
lock-screen Live Activity widget. That single feature rides Apple Push
Notification service and is only available through a native iOS build with
APNs. Reminders themselves arrive on both paths; only the Live Activity is
APNs-exclusive.

## Telegram

Telegram delivers reminders as bot messages, with inline action buttons
on medication reminders (Taken / snooze / skip). It is a good fit when
you already live in Telegram or want push without running a browser.

1. In Telegram, open **@BotFather**, create a bot, and copy the **bot
   token** (it looks like `123456:ABC-DEF...`).
2. Send `/start` to your new bot so it can message you.
3. Find your **chat ID** — send a message to **@userinfobot**, or read it
   from the Bot API.
4. In HealthLog open `/settings/notifications`, fill the Telegram card's
   **Bot Token** and **Chat ID**, toggle it on, and save.

One bot can serve every user on the instance; each user pairs their own
chat ID. The token is encrypted at rest.

## ntfy

[ntfy](https://ntfy.sh) is the most self-hoster-native option: a tiny
pub/sub push relay you can use hosted (`ntfy.sh`) or run yourself. You
subscribe to a **topic** in the ntfy app (iOS/Android) or a browser, and
HealthLog publishes to that topic.

1. Pick a hard-to-guess topic name (the topic _is_ the access control on
   public `ntfy.sh` — anyone who knows the string can read it, so treat
   it like a secret).
2. Subscribe to that topic in the ntfy app or at `https://ntfy.sh/<topic>`.
3. In HealthLog open `/settings/notifications`, set the ntfy card's
   **Server URL** (defaults to `https://ntfy.sh`; point it at your own
   server if you self-host ntfy) and **Topic**, then save.

HealthLog publishes each message as JSON to the server's root URL (the topic
travels in the body, see ntfy's
[publish as JSON](https://docs.ntfy.sh/publish/#publish-as-json)), so titles
and button labels in any language arrive as written. A reverse proxy in front
of your own ntfy has to pass `POST /` through, not only `POST /<topic>`.

If your ntfy server requires auth, an access token can be attached; the
server URL is validated at save time and dialled through the egress guard
(`src/lib/notifications/senders/ntfy.ts`). A self-hosted ntfy on your own
network needs the operator grant described under [Notification targets on
a private network](#notification-targets-on-a-private-network). Urgent
events are sent at ntfy's top priority (`5` / max) so they bypass batching
and surface on the lock screen.

## Webhook

The generic webhook POSTs every enabled event as JSON to a URL you own —
wire it into your own automation (Home Assistant, n8n, a Discord/Slack
relay, whatever routes the payload). You supply the URL and,
optionally, one custom header (e.g. an auth token).

1. In HealthLog open `/settings/notifications`, fill the Webhook card's
   **URL** and, if your endpoint expects one, a single **header name** +
   **header value**.
2. Save. A Test button fires a one-off POST so you can confirm routing.

The URL is validated at save time and dialled through `safeFetch` with
the connect-time resolver pin — the SSRF guard refuses a target that
resolves to a private or loopback address because the target is
user-supplied (`src/lib/notifications/senders/webhook.ts`). A Gotify or
Home Assistant on your own network needs the operator grant described in
the next section. The webhook carries the event's urgency flag so you can
route urgent events differently.

### What the webhook sends

Every event is one `POST` with `Content-Type: application/json` and the
one header you configured. It goes to the URL exactly as you saved it:
nothing is added to the path or the query. The body depends on the
**Payload format** you choose on the card. The examples below are what the
Test button sends.

**Generic JSON** is the default, and what every webhook saved before the
choice existed keeps sending:

```json
{
  "title": "HealthLog Test",
  "message": "HealthLog: Connection successful! Webhook notifications are active.",
  "eventType": "SYSTEM_ALERT",
  "priority": "default"
}
```

- `title` and `message` are plain text. HTML tags are stripped, and routine
  reminders lose their decorative emoji.
- `eventType` is the event name, for routing rules. With discreet cycle
  notifications on, a cycle event arrives as `reminder`, and its title and
  message are masked as they are on every other channel.
- `priority` is a word: `urgent` for an event flagged urgent, `high` for
  medication reminders, `default` for everything else.
- `url`, when `APP_URL` is set, is the page the notification leads to (see
  [Tap targets](#what-tapping-a-notification-opens)). Absent otherwise.

**Gotify** sends the body Gotify's `POST /message` endpoint expects:

```json
{
  "title": "HealthLog Test",
  "message": "HealthLog: Connection successful! Webhook notifications are active.",
  "priority": 5,
  "extras": {
    "client::display": { "contentType": "text/plain" },
    "healthlog::event": { "type": "SYSTEM_ALERT" }
  }
}
```

- `priority` is an integer: `5` for most events, `8` for medication
  reminders, `10` for urgent events. The Gotify Android app plays a sound
  from 4 and shows a heads-up banner from 8, so routine events are audible
  and reminders pop up on screen.
- `extras` tells Gotify clients to show the message as plain text and
  carries the event name, which is `reminder` for a discreet cycle event.

The generic body does not work with Gotify. Gotify reads `priority` as a
number, so the word `default` makes it answer `400 Bad Request`.

### Sending to Gotify

1. In Gotify, create an application and copy its token.
2. On the Webhook card, set **URL** to your Gotify address ending in
   `/message`, for example `https://gotify.example.com/message`.
3. Set **Header name** to `X-Gotify-Key` and **Header value** to the
   application token. Gotify also accepts the token as `?token=` on the URL,
   but in a header it stays out of proxy access logs.
4. Set **Payload format** to **Gotify**, save, and press Test.

If the test fails, the card shows the status Gotify answered and, when it is
short, Gotify's own error text. A `401` means the token is wrong. A `400`
means Gotify could not read the body; check that the format is set to
Gotify. A Gotify on your own network also needs the operator grant below.

The detail reaches the card inside the server's `502` response. A reverse
proxy that replaces error pages for 5xx responses, such as Traefik's
`errors` middleware or nginx with `proxy_intercept_errors on`, swaps that
response for its own page, and the card can then only say "Test failed".
Exclude the `/api/` paths from the error-page rule to keep the detail. This
applies to the ntfy and email tests too.

## Notification targets on a private network

Every webhook and ntfy target is resolved at send time and refused when
the answer is a private, loopback, link-local or CGNAT address. That is
the DNS-rebinding defence, and it applies to a public-looking name with a
LAN A record (a Gotify behind Nginx Proxy Manager with a DNS-01
certificate) exactly as it applies to `http://192.168.1.20`. The test
button and the scheduled delivery take the same decision, so a test that
fails with "Private network target" means nothing would have arrived
either.

The operator opens a target by listing its exact origin in the server
environment:

```env
NOTIFICATION_PRIVATE_ORIGINS="https://gotify.example.com,http://ntfy.lan:8080"
```

Each entry is one `scheme://host[:port]`, the same grammar as
`NIGHTSCOUT_PRIVATE_ORIGINS`:

- only `http` and `https`; scheme, host and effective port must all match
  what the user saves (`https://gotify.example.com:8443` and
  `https://gotify.example.com` are two different grants);
- no path, query, credentials, wildcard (`*.lan`) or CIDR (`10.0.0.0/8`) —
  a range grant would let a DNS rebinding to any address in the range pass
  the pin, so an operator with several relays lists several origins;
- listing a host does not list its sub-hosts or sibling ports;
- the unspecified address (`0.0.0.0`, `::`), link-local and the
  cloud-metadata range (`169.254.0.0/16`, `fe80::/10`) cannot be granted: a
  literal entry is logged once and ignored, and a listed name that resolves
  there is refused at dial time;
- RFC1918, IPv6 unique-local, CGNAT (a Tailscale address or MagicDNS name)
  and, on a host-network deployment, loopback (`http://127.0.0.1:8080`,
  `http://localhost:8080`, `::1`) are what the list is for — an exact
  loopback origin with its port is as deliberate a decision as a LAN one;
- a malformed entry is logged once at first use and grants nothing; the
  valid entries beside it keep working.

A listed origin is still dialled through the pinned resolver with
redirects forbidden, so a relay that answers with a redirect to another
host is refused. The variable has to be on the compose `environment:`
whitelist to reach the container; the published `docker-compose.yml`
lists it. Restart the app after changing it.

What is refused where, so you know which lever to pull:

| Target                                                      | Without the grant | With the exact origin listed                   |
| ----------------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Public name resolving to a public address                   | works             | works, public pin                              |
| Public name with a private A record (LAN reverse proxy)     | refused at send   | works                                          |
| `gotify.lan`, `gotify.home.arpa`, a Docker service name     | refused at send   | works                                          |
| `gotify.local` (mDNS)                                       | refused at save   | allowed, if the container resolves mDNS        |
| Literal `192.168.x.x`, `10.x.x.x`, `100.64.x.x`, `fd00::/8` | refused at save   | works                                          |
| `localhost`, `127.0.0.1`, `::1` (host networking)           | refused at save   | works                                          |
| `0.0.0.0`, `169.254.169.254`, `fe80::…`                     | refused at save   | still refused (`private_origin_not_grantable`) |

A private target that is not listed is refused when the card is saved
(`422`, `meta.errorCode` = `private_origin_not_approved`, the message
names the variable; a link-local, metadata or unspecified target answers
`private_origin_not_grantable` instead, because no grant can open it) or, for a DNS name the save cannot classify, when the
test button or a reminder dials it. The resolved address is never shown
to the user. Telegram, email and Web Push are not affected: their hosts
are not user-supplied.

## Email (SMTP)

The email channel sends reminders to a mailbox over an SMTP transport you
operate or rent. It is configured **instance-wide by the operator** (one
transport serves every user); each user then enables the channel and sets
their destination address from `/settings/notifications`.

Set the SMTP transport in `.env` / the compose `environment:` block:

```env
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_FROM="HealthLog <noreply@example.com>"
SMTP_USER=""           # optional — omit for an unauthenticated relay
SMTP_PASS=""           # optional
SMTP_SECURE="false"    # true = implicit TLS (port 465); false = STARTTLS
```

`SMTP_HOST` + `SMTP_PORT` + `SMTP_FROM` together enable the channel;
`SMTP_USER` / `SMTP_PASS` are optional (omit them for an unauthenticated
relay). `SMTP_SECURE=true` uses implicit TLS on port 465; leave it `false`
for STARTTLS on 587. As with every var in `docker-compose.yml`, these must
be on the compose `environment:` whitelist to reach the container.

## APNs — native iOS, and why it needs your own Apple account

Apple Push Notification service is used by **only** a native SwiftUI iOS
app. PWA, browser, Telegram, ntfy, webhook, and email users never touch
it. It is the one channel a self-hoster cannot simply switch on, and the
reason is worth stating plainly.

### Why your server can't push to the published app

APNs binds a push to a specific **Apple Developer team + app bundle ID +
signing key**. The HealthLog iOS app published on TestFlight / the App
Store is signed under **the maintainer's Apple team and bundle ID**. Your
self-hosted server has neither that team's `.p8` key nor the authority to
mint one, so it **cannot** send APNs pushes to the published app. There is
no way around this — it is how Apple's trust model works, by design.

To get native iOS push **and** the lock-screen Live Activity widget on
**your own** infrastructure, you have to publish your own copy of the app
under your own Apple identity. Everything below is that path.

### Step by step — your own native iOS build

1. **Get an Apple Developer account** (~$99/yr). Required to sign an iOS
   app for a real device and to create a push key.
2. **Build and sign your own copy of the iOS app.** The client is open in
   a separate repository (`healthlog-iOS`). Open it in Xcode and set your
   **own bundle identifier** and **your team** as the signing team, then
   build to your device (or distribute via your own TestFlight).
3. **Create your own APNs `.p8` auth key** in the Apple Developer Portal,
   under **Keys → Create a Key → Apple Push Notifications service (APNs)**.
   Note the **Key ID**, and your **Team ID** (top-right of the portal).
   Scope the key **Sandbox & Production** (see the gotcha below).
4. **Point your bundle ID at your server.** Build the iOS app against your
   instance so the device registers its APNs token with your server.
5. **Set the APNs manifest on the server.** Add the env vars below to
   `.env` / the compose `environment:` block.

The APNs env vars (`src/lib/notifications/senders/apns.ts`):

| Variable                    | Purpose                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `APNS_KEY_ID`               | The `.p8` key's Key ID                                                              |
| `APNS_TEAM_ID`              | Your Apple Developer Team ID                                                        |
| `APNS_BUNDLE_ID`            | Your app's bundle identifier                                                        |
| `APNS_KEY_B64`              | The `.p8` PEM, base64-encoded (recommended key source)                              |
| `APNS_KEY`                  | OR the raw PEM body inline                                                          |
| `APNS_KEY_FILE`             | OR a path to the `.p8` file                                                         |
| `APNS_CRITICAL_ENTITLEMENT` | Optional — set `true` only if Apple grants your app the Critical Alerts entitlement |

APNs is **all-or-none**: either set the three IDs plus exactly one key
source, or leave the whole block unset. A partial config is rejected so
the channel never silently half-works (`scripts/check-env.ts`). When more
than one key source is present, the precedence is `APNS_KEY_B64` >
`APNS_KEY` > `APNS_KEY_FILE`.

`APNS_CRITICAL_ENTITLEMENT=true` is honoured only if Apple has actually
granted your app the Critical Alerts entitlement (a separate request to
Apple). Without that entitlement, leave it unset — the server keeps urgent
events at normal priority rather than minting a `critical` payload your
app cannot send (`src/lib/notifications/types.ts`).

Two gotchas worth knowing before you blame a stale token:

- **Base64 the key.** Pasting a raw `.p8` PEM through some env-file
  pipelines mangles its line breaks. `APNS_KEY_B64` (the PEM body,
  base64-encoded) sidesteps that entirely and is the recommended source.
- **Scope the key "Sandbox & Production".** In the Apple Developer
  Portal, a push key defaults to Sandbox-only. A Sandbox-only key fails
  on production (TestFlight / App Store) device tokens with
  `BadEnvironmentKeyInToken`. Confirm the key shows **Sandbox &
  Production**; a wrongly scoped key cannot be reconfigured — re-issue it.

> **`clientManaged` is iOS-app-only.** A native iOS app can opt to run its
> own local medication reminders and ask the server to stop sending the
> duplicate `MEDICATION_REMINDER` push (the `clientManaged` flag on
> `PATCH /api/auth/me/notification-prefs`). This is a native-app contract:
> a web/PWA-only self-hoster never needs it and there is no toggle for it
> in the web UI. If you only run the PWA, ignore it entirely — your
> medication reminders come from the server cron over the channels above.

## Tap targets, content and quick answers

### What tapping a notification opens

Every notification leads somewhere in the app. The server decides where,
once per event type, and every channel carries the same target:

| Notification                                 | Opens                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| Mood reminder                                | `/mood`, with the mood entry sheet already open                                    |
| Morning briefing                             | the dashboard                                                                      |
| Medication reminder, low supply, shared dose | `/medications` (low supply opens the medication)                                   |
| Check-up and measurement reminders           | `/checkups`                                                                        |
| Proactive Coach nudge                        | the Coach conversation it started                                                  |
| Cycle reminders                              | `/cycle` (the dashboard with discreet notifications on)                            |
| New sign-in                                  | Settings, Security                                                                 |
| Integration sync failing                     | Settings, Integrations (an admin alert about another account opens the admin page) |
| Illness red flag                             | the illness episode                                                                |
| Other system alerts                          | the dashboard, or the admin status page for operator alerts                        |

How each channel carries it:

- **ntfy**: the message's `click` field, so tapping the notification opens
  the page.
- **Telegram**: an **Open in HealthLog** button under the message, below any
  action buttons. Telegram only accepts `https` button links on a public
  host, so a plain-HTTP instance gets a text link instead, and an instance
  on `localhost` gets no link.
- **Web Push**: the service worker opens the page, or focuses an open
  HealthLog tab and navigates it there.
- **APNs**: the path rides the payload as `url`.
- **Webhook**: the generic body gains a `url` field; the Gotify body gains
  `extras["client::notification"].click.url`, which the Gotify app opens.
- **Email**: a link line under the message.

ntfy, Telegram, the webhook and email need an absolute link, built from
`APP_URL` (or `NEXT_PUBLIC_APP_URL`). Without one those channels deliver as
before, just without a link. A notification about a profile you look after
as a Guardian opens the dashboard rather than the profile's page, because
your session opens on your own record and the record switcher lives there.
A discreet notification opens the dashboard as well, so its link names
nothing. The silent background sync push for medication intake is the only
notification without a link.

### Health figures in notifications

Settings, Notifications, **Health figures in notifications** decides what a
notification may say on a lock screen:

- **Off** (the default): a notification says what it is about and shows no
  health figure. The morning briefing reads "Your morning briefing".
- **On**: notifications add their figures. The morning briefing becomes
  "Morning score 78" with the day's one-line summary underneath.

Tap targets and quick answers work the same either way. The setting is
stored as `content.detail` (`generic` or `detailed`) in the notification
preferences (`PATCH /api/auth/me/notification-prefs`) and travels with the
account backup.

### Quick answers on the mood reminder

On **ntfy** the mood reminder carries three buttons, **Good**, **Okay** and
**Bad**. Tapping one logs a mood entry straight from the notification,
without opening the app, and clears the notification. They map onto the
five-point mood scale as Good = 4, Okay = 3, Bad = 2; the outer points
stay in the app. The entry is marked with the source **Notification**.

Each button calls `POST <APP_URL>/api/notifications/action/<token>`. The
token is the only credential, so it is built to be harmless on its own:

- it is signed with `API_TOKEN_HMAC_KEY` and names one account and one
  answer, so it cannot be moved to another account or another answer;
- it expires six hours after the reminder was sent;
- the three answers of one reminder are one use between them: the first
  tap logs, every later tap on that reminder is refused, and that stays
  true when the logged entry is deleted and purged from the trash before
  the six hours are up;
- the route is rate-limited before it reads the token, refuses when the
  mood module has been turned off, and the token is scrubbed from logs.

The buttons need `APP_URL`, because the ntfy app calls the URL from your
phone. Your phone has to reach the instance at that address.

### Quick answers behind forward auth

If the instance sits behind a forward-auth gateway (Authelia, Authentik,
oauth2-proxy, Cloudflare Access and the like), the gateway answers the
button's request with its login page and the answer is never logged: the
ntfy app has no session with the gateway. Exempt the one path from the
gateway:

```
/api/notifications/action/*
```

The route does not rely on the gateway. The signed token is its only
credential, it is rate-limited before the token is read, and it can log one
mood answer for one account and nothing else. Every other path stays behind
the gateway.

What the token cannot protect against is the topic itself. The button URLs,
token included, travel through your ntfy server inside the message, and the
message is delivered to everyone subscribed to the topic. For the six hours
a token is valid, anyone who can read the topic can log that one answer on
your behalf. On the public `ntfy.sh` the topic name is the only access
control, so:

- use a long, random topic name and do not share it;
- better, run your own ntfy server with access control and give HealthLog
  an access token that may only publish to your topic;
- to invalidate every quick-answer token at once, rotate
  `API_TOKEN_HMAC_KEY`. The same key also hashes API tokens and session
  cookies, so rotating it invalidates every issued API token and signs out
  every browser session and the iOS app as well (see
  [getting started](./getting-started.md)).

**Telegram** keeps its own keyboard on the mood reminder: the full 1 to 5
scale, a note and a "later" button.

**Web Push** offers no buttons. Most browsers show at most two actions,
which cannot carry a three-way answer, and Safari on iPhone shows none.
Tapping the notification opens the mood entry sheet instead.

**APNs**: the iOS app draws its own buttons from the notification category
it registers for the mood reminder.

## Which channel should I pick?

| Your setup                                        | Recommended channel                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| PWA on Android or desktop                         | **Web Push** — generate a VAPID keypair, subscribe, done.                                                                                           |
| PWA on an iPhone                                  | **Web Push**, but install the PWA via _Add to Home Screen_ first (iOS 16.4+). Reminders work; the lock-screen Live Activity needs a native build.   |
| You want the native iOS lock-screen Live Activity | Build and sign **your own** iOS app under your own Apple account and wire up **APNs** (paid), with Web Push as a fallback for any non-iOS device.   |
| Headless / no browser, or you live in chat        | **Telegram** or **ntfy** — neither needs a browser, both are free. ntfy is the most self-host-native; Telegram adds inline reminder action buttons. |
| You already run an automation hub                 | **Webhook** — POST every event to your own URL and route it however you like.                                                                       |
| You want reminders in your inbox                  | **Email** — set the SMTP transport once as the operator; users add their address.                                                                   |

Mixing channels is fine and common — e.g. Web Push on the laptop and
ntfy on the phone. Each user configures their own set from
`/settings/notifications`.
