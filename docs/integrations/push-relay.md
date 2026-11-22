# Push relay

Apple delivers a push to the HealthLog app from the App Store only when it is
signed with the key of the Apple developer account that publishes the app. A
self-hosted server does not have that key, so on its own it cannot reach the
App Store app: no confirmation that a dose was recorded on another device, no
silent sync, no ending the Live Activity from the server.

The push relay closes that gap. It is a small service run by the HealthLog
project at `push.healthlog.dev`. Your server seals each notification for the
device it is meant for, hands the sealed envelope to the relay, and the relay
passes it to Apple inside a fixed template. The relay holds the APNs key; it
never holds a key that opens an envelope.

The relay's source, protocol and test vectors are public in the
`healthlog-push` repository (Apache-2.0; the specification and vectors CC0).

## What the relay sees, and what it does not

The relay sees delivery metadata (the device's push token while it forwards,
kept at rest only as a keyed hash; your server's instance id; the class,
lifetime, size and time of each push; the version of the person's consent),
never what a notification says; the full list, and how long each item is kept,
is the relay's privacy notice at `https://push.healthlog.dev/privacy`, which
is the authoritative text. With the separate Live Activity consent (see "Live
Activity start and update" below), the content state of a Live Activity start
or update passes the relay and Apple in the clear.

Every alert and every silent push carries an envelope sealed with HPKE
(RFC 9180, auth mode, X25519, HKDF-SHA256, ChaCha20-Poly1305) for that one
device. The envelope has
a fixed size per class and its header names no key, so envelopes do not tell
devices or servers apart either.

Within a class the relay cannot tell one kind of push from another. Over the
relay every alert lives 15 minutes and every silent push an hour, whatever it
is, and the retry schedule is one per class too. What stays readable beside
the envelope, because the relay needs it to hand the push to Apple:

- the class (alert, silent, Live Activity), which also sets the APNs
  priority: 10 for an alert, 5 for a silent push;
- the remaining lifetime (`ttlSeconds`, rounded down to the minute), which
  falls with each retry and names nothing finer than the class;
- the size, which is fixed per class, and the time;
- an opaque collapse id per device, the same for pushes that replace each
  other (a reminder and its follow-ups for one dose, a device's intake
  syncs), so the relay can see that two pushes belong together, never what
  they are about;
- for a Live Activity push, its event (start, update or end).

What timing can reveal is said plainly: if you record a dose on one device
and another device of yours gets the confirmation, the relay and Apple can
see that something happened at that moment, and a medication reminder that
goes over the relay shows them when a dose is due. Apple can link the timing
to your Apple account. That is why a device that plans its own reminders
keeps them off the relay, and why turning the relay on is each person's own
choice.

The holder of the relay's APNs key (the relay operator, or anybody who steals
that key) can make a notification appear in the app's name. They cannot read
your data, and the app acts only on notifications whose envelope opened with
a sender key it pinned from your server.

## Turning it on

The relay is off until the admin turns it on.

1. After the update every admin sees a one-time notice on the admin start
   page that the option exists. It can be dismissed and does not come back.
2. In **Admin > Push and channels**, switch on **Offer the HealthLog push relay to this
   server's users**. The dialog asks for three confirmations, each with its
   own checkbox: that you accept the relay terms, that you have read its
   privacy notice, and that you run this server privately for yourself or
   your household. The hosted relay is for private and household use only and
   is not a medical service. The card lists what the relay sees and what it
   does not under **What the relay sees**, with a link to the full privacy
   notice.
3. Your server creates its instance key, stores it encrypted, and registers
   with the relay. The card then shows the relay's state and how many devices
   are bound.
4. Each person sees a card in the iOS app once and decides for themselves.
   This needs the iOS app 1.7 or later; an older build keeps its local
   reminders.
   Only "Turn on" creates the keys on the iPhone and binds it. The choice
   stays in the app's notification settings and can be withdrawn there at any
   time, even while your server is unreachable.

When the relay's text changes in an update, as it did in 1.49.0 when
medication reminders began to go over the relay, the card asks every admin to
read the new text and confirm it once (**Read and confirm**). The relay keeps
running until then, and confirming changes nothing at the relay. The version
of the consent text people see in the app (`push.relay.consentTextVersion` on
`/api/auth/me`) moves with it, so the app can show its card again; the server
never unbinds a device over an older version.

Turning the switch off deletes your instance at the relay, which removes every
device binding with it, and deletes the instance key here. If the relay is not
reachable at that moment, the server keeps the key, sends nothing, and retries
the deletion until the relay confirms it. Revoking a device or withdrawing
consent reaches the relay the same way. The apps notice it
on their next sync and go back to local reminders on their own.

### Invite codes

A relay can accept new servers by invitation only. The hosted relay may run
that way during a test phase, so a server that registers for the first time
can need a one-time invite code. Ask for one at `relay@healthlog.dev`; if you
run your own relay, `healthlog-push admin invite` prints one. A code has 24
characters (letters, digits, `-` and `_`), is valid for 7 days and registers
exactly one server.

Enter the code in the **Invite code (optional)** field of the dialog when you switch the
relay on. Without a code the field stays empty and nothing changes for a relay
that accepts everyone. The code is sent with that one registration and is
never stored or logged on your server; the relay spends it only when the
registration succeeds.

If the relay refuses, the card says why within the same click:

- **This relay accepts new servers by invitation only.** No code was entered.
  Use **Enter invite code** on the card and try again.
- **The relay did not accept this invite code.** The code is unknown, expired
  or already used. Ask for a new one.
- **The relay is not taking new servers right now.** Registration is paused at
  the relay. Your server asks again on its own once the relay's pause is over.

After an invite refusal your server does not keep asking the relay; it waits
until you enter a code. A server that is already registered never needs a
code again, also not after an update or a relay restore.

### Checking it works, and the instance key

The relay card has **Send test push**: one harmless sealed notification to
each of your own devices that use the relay. The card shows what the relay
answered, verified against its pinned signing key, and whether the push was
accepted for delivery. Use it after turning the relay on, after an update, or
when someone says notifications stopped.

Your server signs every relay request with its own instance key. It replaces
that key every 30 days through the relay's rotation endpoint, and **Rotate
relay key** does it at once (the relay allows one rotation a day). The new
key is kept before the request leaves, so a lost answer cannot lock the
server out, and the old one is kept for 7 days.

### Sender keys

Envelopes are sealed with this server's sender key, which every device pins.
A new sender key is announced to the apps as `next` at least 7 days before
it seals anything, then becomes `current`; the old one stays pinned as
`previous` for 30 days and is then deleted. The regular rotation is yearly.
If a sender key is ever exposed, `POST /api/admin/push-relay/rotate-sender-key`
(an admin with a fresh second factor, audit-logged) replaces it at once;
devices that have not fetched the new key show a neutral notification until
the app is opened.

### Deleting an account

When an account is erased (by the person, by an admin, or by the purge after
the grace window), the server tells the relay to drop the binding of each of
its devices. The unbind is queued with the erasure and sent by the relay's
background pass, so a relay that is down delays it without blocking the
deletion; it is retried for 7 days. The app's own "turn off" also revokes its
binding directly at the relay.

Only the relay's signed answer confirms an unbind. While your server cannot
reach the relay it registered with (`PUSH_RELAY_MODE=off`, or a
`PUSH_RELAY_URL` changed after the relay was turned on), the unbinds wait and
the relay card says how many, and that the server is still registered there.
That relay keeps the server's device bindings until the server leaves it:
set the variable back and switch the relay off. An unbind is dropped unsent
only when no relay holds a binding of this server any more.

### What goes over the relay

- the medication reminder, to the devices that get their reminders from this
  server (see below);
- the confirmation that a dose was recorded on another device;
- the silent sync that tells another device to refresh;
- the end of a medication Live Activity, sent with a statement the device
  signed when the Activity started (the relay never learns when an Activity
  starts);
- other server notifications such as low stock or a seizure cluster;
- security alerts: a sign-in from a new device, a passkey added or removed,
  an access token revoked, a device signed out because its sign-in token was
  used twice. They break through a Focus (time-sensitive);
- a silent wake when a server-side sync stored new readings (Withings,
  Garmin, Oura, WHOOP, Polar, Strava, Google Health, Nightscout, or a food
  tracker posting with a token), so the app, its widgets and the Watch are
  current without opening the app. It names only the kind of data that
  changed (measurements, sleep, workouts, nutrition), never a value;
- a silent wake asking the app to run its Apple Health upload when the
  server has received nothing from it for six hours while the app is still
  in use.

### Live Activity start and update

Starting a medication Live Activity from the server, and updating it as the
dose turns due, overdue or is snoozed, is a separate choice. The content a
Live Activity shows cannot be sealed, so the relay and Apple can see when a
dose is due. The app asks for it with a second switch of its own, off by
default, beside the relay switch; the device signs that consent with its
binding key, and turning the relay off turns it off too. The content carries
only the state and the timing (pending, due, overdue, snoozed, the countdown
and the time format), never a medication name; the relay refuses anything
else. Each dose starts at most one Activity, and the relay limits starts and
updates per device and day.

On the server it is held back by `PUSH_RELAY_LIVE_ACTIVITY` until the app's
device test has passed; while that is off only the end of a Live Activity goes
over the relay. A server with its own APNs key is not affected.

### How often

The silent wakes are rationed, because Apple stops waking an app that gets
too many of them:

- the data wake goes out at most once every five minutes and three times an
  hour per account; changes in between are merged into the next one, never
  dropped. A sync you started from a device does not wake that device, it
  already has the result;
- the Apple Health wake goes to a device at most three times a day, at least
  four hours apart, and only while the app was opened in the last three days;
  after two weeks without any upload the server stops asking;
- no device gets more than four of these wakes an hour together, and over the
  relay none beyond the relay's own six silent pushes per device and hour.

Both wakes go only to app versions that registered a push key; older app
versions get nothing new. A server with its own APNs key sends the same
sealed wakes itself.

Mood, measurement and cycle reminders do not go over the relay; the app plans
them itself. A medication reminder goes over the relay to exactly the devices
the server would remind over its own APNs key: a device set to server
delivery, a device without its own setting on an account set to server
delivery, and a device that reminds itself but whose local plan has run out
(past the runway it reported, or 3 days without a request). A device that
reminds itself keeps the reminder, and the follow-ups for a dose still open,
on the iPhone.

Nothing about another person's record (guardian features) goes over the
relay: no reminder or other alert about a managed profile, and not the silent
intake sync a guardian's device gets when a managed profile's dose changes.
Over the server's own APNs key that sync still reaches the guardian's
devices; over the relay the app refreshes a managed profile when it opens.

### Diagnostics on the device

The app's push diagnostics screen reads `GET /api/devices/me/push-diagnostics`
for the device it runs on (named by its `X-Device-Id`). It shows how pushes
reach that device (the relay, the server's own APNs key, or not at all),
whether they are sealed, the relay's state and the device's binding, whether
the server or the app reminds the device of a dose (and until when the app
does), and the
silent budget: how many of the six silent pushes an hour the device has used,
how many of the four wakes, whether an intake sync is owed and when the next
one fits. It also lists the newest push of each kind (alert, silent sync,
wake, Live Activity) with its outcome, the last receipt the app sent back, and
the APNs token, masked to its first and last eight characters.

It never shows another device, a token in full, or what a notification said.
Over the server's own APNs key the alert row appears only while the device is
the account's one APNs device, because the server records those attempts per
account, not per device. Operators who need the whole account see the same
values, computed by the same code, in the admin notification diagnostic.

### When the relay is down

A device that plans its own reminders keeps them. A device that gets its
reminders from this server gets none whose deadline passes during the outage.
Your server keeps each push with its deadline (an alert 15 minutes, a silent
push 1 hour, a Live Activity end 4 hours, a Live Activity start or update 15
minutes) and retries with backoff; a push past its deadline is dropped, never
delivered late. After three failed connections in a row the server stops
trying item by item and checks the relay's status every minute, later every
five.

A relay outage never counts against a device or switches a notification
channel off. Only Apple's "unregistered" answer for a device token deletes
that device, and if more than a third of the relay devices get that answer
within an hour, the server holds further deletions for a day, because that
pattern points at a fault, not at a wave of uninstalls.

While the relay is down, or when pushes it accepted never arrived on a
device, the app shows that syncing with your other devices is disrupted, so
nobody relies on a confirmation that did not come.

## Privacy notice in short

The relay operator is the maintainer of the HealthLog project, acting as an
independent controller for the relay's metadata. Delivery rests on each
person's consent, given on the app's card and withdrawable there at any
time; without it nothing goes over the relay and everything else works as
before. In the app, "My data at the relay" shows what the relay holds about
the device, and turning the relay off erases it. What is kept and for how
long is in the relay's privacy notice, `https://push.healthlog.dev/privacy`,
and its terms are at `https://push.healthlog.dev/terms`.

## Configuration

All optional, all on the compose whitelist.

| Variable                   | Default                      | Meaning                                                                                                                                                                        |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUSH_RELAY_MODE`          | `allowed`                    | `off` hides the relay and its admin notice; a server still registered with a relay keeps the card, saying so, until it has left that relay                                     |
| `PUSH_RELAY_URL`           | `https://push.healthlog.dev` | the relay origin; `https` only                                                                                                                                                 |
| `PUSH_RELAY_KEYS`          | the hosted relay's keys      | the relay's identity public keys, Ed25519, unpadded base64url, comma separated                                                                                                 |
| `PUSH_RELAY_LIVE_ACTIVITY` | off                          | `on` lets Live Activity start and update go over the relay to devices whose owner gave the separate Live Activity consent; leave it off until the app's device test has passed |

Every relay answer must carry a signature by one of the pinned identity keys,
bound to the method, path and nonce of the request it answers, and fit the
expected shape and size (at most 256 KiB). Retry hints are taken only from the
signed body, never from the unsigned `Retry-After` header, and capped at a
day. An answer without one is treated as if it
never arrived; it is never read as a refusal, a revocation or a deletion. A
relay without pinned keys cannot be used at all.

A server with its own APNs key (`APNS_*`) does not need the relay. It seals
the same envelopes and sends them to Apple itself, so the app sees one format
on every path.

## Running your own relay

A relay you run yourself cannot serve the App Store app: Apple accepts pushes
to that app only with the HealthLog project's key. Your own relay works with
an app you build from source and sign with your own Apple developer account.

- One server and your own app build: use your own APNs key (`APNS_*`); no
  relay needed.
- Several servers, or an organisation, with your own app build: run your own
  relay from the `healthlog-push` repository, set `PUSH_RELAY_URL` and
  `PUSH_RELAY_KEYS` on each server, and point your app build at it.

Organisations (a practice, a care service, an association) do not use the
hosted relay under its terms; they use their own APNs key, their own relay, or
contact `relay@healthlog.dev`.
