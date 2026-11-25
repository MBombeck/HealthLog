# Searching your record

The command palette finds pages and settings, and it searches what you have
recorded.

Every page with an address and every Settings card with its own anchor is in
it, by its name in your language and by the words people type for it: "snooze"
finds **Remind me later**, "dark mode" finds the theme, "Nextcloud" finds the
Health Connect folder, "ICE" or "QR" the emergency card. The list comes from the
same registry the navigation and Settings are built from, so a new page is
searchable the day it ships.

## Opening it

Press **⌘K** on a Mac or **Ctrl K** elsewhere, or tap the magnifier at the
top right, and start typing.

## What it finds

Below the pages and settings, a section **In your records** lists the
entries that match what you typed:

- visits (procedures included)
- conditions
- documents, by title, file name and the text read from them
- vaccinations
- lab results
- medications
- symptoms
- workouts
- notes on mood entries, readings and illness days

Each hit opens where the entry lives: a visit on the Care page, a lab
result on its analyte, a note on a mood entry or a reading on its day, a note
on an illness day in its illness.

## How matching works

Case and accents do not matter, so "schulter", "Schulter" and "Schülter"
find the same entries. Umlauts can be typed as `ae`, `oe` and `ue` (and `ß`
as `ss`), which helps on a keyboard without them.

## Very large records

The search reads each kind of entry newest first and stops after a fixed
number of entries and a short time limit, so it stays quick on a record that
holds years of data. When it stopped before reaching the oldest entries, the
list says so. A more specific search term usually finds an older entry.

## Shared records

When someone has shared their whole record with you, the search works inside
that record too. An account shared with you section by section cannot be
searched: the search lays every section side by side, which a partial share
does not open.

## Privacy

What you type is sent to your instance in the body of the request, not in the
address, so it does not end up in a reverse proxy's access log or in the
browser history. The server does not log the search text either, only its
length and how many hits it found.
