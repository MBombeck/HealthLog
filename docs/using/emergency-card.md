# The emergency card

The emergency card is the emergency information from your health profile, in
a form you can carry: on your phone, in your wallet, and behind a QR code a
first responder can scan. It holds what you have entered and nothing more.

## What is on it

The card is assembled from what you already keep in HealthLog:

- blood type, implants and devices, emergency contacts, the advance directive,
  the organ donor declaration and the note, from **Settings**, **Health
  profile**, **Emergency information**;
- your active allergies, severe ones first, with the reaction where recorded;
- ongoing chronic conditions and the conditions you wrote in your health
  profile;
- medications that are active, not paused and not ended;
- the pregnancy or the weeks after a birth, when cycle tracking holds that
  state;
- your date of birth.

Open **Emergency card** from the account menu (your avatar, at the bottom of
the sidebar or at the top right on a phone), or use the button on **Emergency
information** in **Settings > Medical history**, the row in **Settings >
Health record**, or search for "emergency card". The address is
`/emergency-card`.

It is the card of the record on screen. In your own record that is yours. The
guardian of a managed profile holds the profile's card, so inside that profile
the page shows and manages the profile's card. Someone who shares an adult's
record never sees or manages that person's card, at any access level.

## On your phone, without a connection

HealthLog does not work offline on purpose: a signed-in page is never stored
on the device, so a lost phone does not hand out your record. **Save offline
copy** downloads the card as one HTML file instead. It has no script and makes
no network request, so it opens from the Files app or a home-screen bookmark
with no connection. It shows what the card held on the day you saved it, and
says so; save it again after a change.

## In your wallet

**Wallet card (PDF)** prints both sides of a credit-card-sized card on one A4
page: print at 100 percent, cut along the outline, fold at the dashed line.
The front holds blood type, allergies, conditions, medications and a
pregnancy; the back holds contacts, implants and the declarations. Text that
does not fit is shortened, and the card says the full card is behind the QR
code.

## The QR link

The QR link lets someone read the card without signing in. You decide:

- **what it shows**: tick each item; nothing you leave unticked is ever read
  for the link. The form starts with blood type, allergies, conditions,
  medications, pregnancy, implants and contacts ticked; the date of birth,
  the note and the two declarations only appear when you tick them;
- **when it ends**: never, or in 30 days, a year or two years;
- **whether it lives**: revoke it at any time, and the code answers nothing
  from then on.

The link and its code are shown once, when you make the link, so the page
offers **Wallet card with QR code (PDF)** right then. Making a link asks you to
confirm it is you. The page tells you how often the link was opened and when
last, and every opening is written to your audit log. Only one link is live at
a time; to change what it shows, revoke it and make a new one, then print the
card again.

The link is a credential like the clinician share link. HealthLog stores only
its hash, rate-limits every attempt before looking it up, answers every
unknown, revoked or expired link with the same "not found", keeps it out of
its own logs, and never caches the page. Changing your password, or an
administrator resetting it, revokes it as well. It is not part of a backup: after a
restore, make a new link. If the operator turns off the **API** switch
("Allow API endpoints and API tokens.") under **Admin > Push and channels**, the link
stops working too, as do the cycle and care calendar feed links.

## Wallet passes

An Apple Wallet pass would need a pass-type certificate from Apple's
developer program, signed on the server for every pass. HealthLog does not
ship one. A self-hoster who wants passes would need their own Apple developer
account and certificate, so it is not offered; the printed card and the iOS
app's own lock-screen options cover the same need.
