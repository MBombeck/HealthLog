# The emergency card

The emergency card is the emergency information from your health profile, in
a form you can carry: on your phone, in your wallet, in Apple Wallet, and
behind a QR code a first responder can scan. It holds what you have entered and nothing more.

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

## In Apple Wallet

**Add to Apple Wallet**, under **Apple Wallet** on the card page, makes a pass
of the card for Wallet on an iPhone, an iPad, a Mac or an Apple Watch. On
another device the page asks you to open it on one of those.

**What is on it.** The front holds three things a helper needs in a few
seconds: your name, one short value beside it (a pregnancy when there is one,
otherwise your blood type) and one warning line, the first allergy (marked
severe when it is) or else your first condition. Without the name, the most
urgent warning takes its place. Above them are the date the pass is as of and
the QR code. Everything else you tick is in the pass's details, and where the
pass comes from is on its back. The name is ticked by default; untick it to
keep it off.
What you tick is frozen when you add the pass. To change it, withdraw the pass
and make a new one.

**It updates itself.** When something on the card changes (an allergy, a
medication, your emergency details, your name), the pass is rebuilt about a
minute later and Wallet fetches it; the date on the front moves with it. A
burst of edits reaches a phone at most once every 15 minutes, and the server
also looks every six hours, so a new day (a medication course ending, the
next week of a pregnancy) reaches the pass without an edit.

**Its own QR code.** The pass carries a link of its own, apart from the
printed card's, with the same rules: read-only, rate-limited, every opening on
your audit log, an optional end. Revoking the printed card's link leaves the
pass alone, and withdrawing the pass leaves the printed card's link alone.

**On another device.** Once a device has the pass, the card page offers
**Add to another device**: the same pass, for an iPad or a Mac as well.

**Withdrawing.** **Withdraw pass**, after a confirmation, stops its QR code at once, and Wallet
replaces the pass with one that says it is withdrawn and holds no health data.
A password change, an administrator's reset, asking for the account to be
deleted, the handover of a managed profile, or a guardian losing the right to
manage the profile withdraw it the same way. The card page says when and why.
A phone that is offline keeps showing the old pass until it is back online;
the QR code is dead either way. When a pass cannot be updated any more (after
a restore from backup, after "Delete all data", or when the server changed
how it signs passes), delete it in Wallet by hand.

**When it ends.** A pass made with an end date is greyed out by Wallet itself
on that day, even offline.

**On a locked phone.** Wallet shows the pass only after Face ID or your code.
For helpers at a locked iPhone, fill in the Medical ID in the Health app as
well. If you sync passes through iCloud, they are end-to-end encrypted only
with Advanced Data Protection turned on.

**Who signs it, and what they see.** A pass has to be signed with an Apple
certificate. By default the HealthLog project signs it through the push relay:
the signing service gets the list of file names and their hashes, and so it
learns that your server asked and when, never what the card says, its link or
the pass's serial number. You confirm that once before the first pass. For
updates, the relay passes an empty push to the phones that hold the pass; it
sees the pass's push token while it forwards and the time, so the timing can
show that something on the card changed, never what. An operator with an
Apple developer account can sign on the server instead and push straight to
Apple, with nothing going through the project
(`docs/self-hosting/apple-wallet.md`). On a server without either, the button
is not offered and the page says why.

Passes are not part of a backup: after a restore, add the card again.

Google Wallet follows later, as a pointer card with the QR code and no health
data.
