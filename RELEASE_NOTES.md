# N2O Sync Lite 1.0.6

A correction to yesterday's 1.0.5, plus everything 1.0.5 brought. If you are coming
from 1.0.3, read the whole page. Nothing already in your vault is deleted or
rewritten.

## The correction

**1.0.5 said database rows were free. They are not, as of 1.0.6.**

The limit is 100 notes per vault, and **every synced note counts** - a standalone
page and a row inside a database count exactly the same. A row in a Notion database
is a page in Notion's own model, and it lands in your vault as a note like any other,
so exempting rows meant a single 500-row database could quietly carry a whole
workspace past a cap that claimed to be 100. That was the wrong call and it lasted
one release.

If you installed 1.0.5 yesterday, your vault has not changed and nothing has been
removed. What changed is the arithmetic: notes that used to cost nothing now count.
**Anything already synced keeps syncing regardless**, so nothing you have breaks.

## What Lite no longer does, from 1.0.5

**100 notes per vault.** Notes you have already synced keep syncing forever, even if
you are over the limit, so no working vault breaks on an update. Only genuinely new
notes past the limit are refused, and a run that hits the limit says so plainly
instead of reporting success.

**Nothing is merged for you.** If you edit a note in Obsidian and the same page also
changes in Notion, Lite no longer tries to combine them. Your file is left exactly as
it is, and Notion's version is written beside it as `<name>.conflict.md` so you can
compare the two and keep what you want. Your work is never overwritten without a copy
being saved first.

**Notion colours, page covers and page icons are no longer drawn.** Notes take your
Obsidian theme instead. The data is still there: the cover image is downloaded and
its path written to frontmatter as `n2o_cover`, and the page icon lands in `icon`, so
a plugin like Pretty Properties or Banners can render them however you prefer.

## Four bugs that could lose your work

These are the reason to update even if you liked things as they were.

**Retrying a failed image download could overwrite a note you had edited.** The guard
against it existed, was opt-in, and nothing opted in. It is now on by default, and
nothing overwrites a note until a copy of it is saved.

**Every page with a cover image was permanently in conflict.** A frontmatter backfill
rewrote the file after its content hash was taken, so the note never matched its own
record and every sync reported a change nobody made.

**Concurrent database writes could collide and lose a page's sync record**, which
made that page look unsynced and re-sync from scratch.

**The manual install instructions named a folder Obsidian will not load.** If you
installed by hand and it never appeared, that was why. The folder must be
`notion-pull-lite`.

## Smaller things

- The panel reported "0 pages, 0 databases" straight after a successful sync. It now
  reports what is actually in your vault.
- A tab in settings explains what the full edition adds, what it costs, and what
  happens if you try it. Nothing pops up and nothing is disabled to make a point.
- A welcome note is written into your sync folder on a first sync. If you are
  updating you have already synced, so you will not see it. This page is your copy.
- The two Performance sliders are gone. One of them was wired to nothing at all.

## Full source

Built from source in CI, with build provenance attestation on every asset. The
network surface is unchanged and enforced on every build: `api.notion.com`, the
sign-in server if you use "Connect with Notion", and `api.github.com` only when you
press Install on the full edition.
