<p align="center">
  <img src="https://n2osync.com/logo-square.png" alt="N2O Sync Lite" width="110" />
</p>

<h1 align="center">N2O Sync Lite</h1>

<p align="center">
  <strong>Your Notion workspace, in your vault, in plain Markdown.</strong><br/>
  Pull pages and databases into Obsidian as clean Markdown. Free, open source, up to 100 pages.
</p>

<p align="center">
  <a href="https://github.com/n2osync/n2o-lite/releases/latest"><img src="https://img.shields.io/github/v/release/n2osync/n2o-lite?style=flat-square&sort=semver&label=version" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22notion-pull-lite%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json&style=flat-square" alt="Obsidian downloads">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT licence">
  <img src="https://img.shields.io/badge/Obsidian-1.7.2%2B-7c3aed?style=flat-square" alt="Obsidian 1.7.2+">
</p>

<p align="center">
  <a href="https://n2osync.com">Website</a> /
  <a href="https://n2osync.com/docs">Docs</a> /
  <a href="https://github.com/n2osync/n2o-lite/issues/new">Report a bug</a> /
  <a href="https://github.com/n2osync/n2o-lite/issues/new">Request a feature</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/n2osync/n2o-lite/main/.github/assets/n2o-sync-demo.gif" alt="Picking Notion pages in N2O Sync Lite and pulling them into an Obsidian vault as Markdown" width="820" />
</p>

---

> **Not a Notion product.** N2O Sync Lite is an independent Obsidian plugin. It is
> not made by, endorsed by, or affiliated with Notion Labs or Obsidian. It uses
> Notion's public API with a token you provide.

> **It only reads from Notion.** Lite never writes to your Notion workspace, so
> there is nothing it can break over there. The only thing it changes is your
> vault.

## The problem

You have years of work in Notion. Meeting notes, project databases, research,
half-finished writing, the wiki nobody else maintains.

It lives on somebody else's server, in somebody else's format. Notion's own
Markdown export is a manual `.zip` you have to request, where every filename has
a 32-character UUID stapled to the end, internal links point at files that no
longer exist, and databases arrive as loose CSV. There is no incremental option
and no way to schedule it. Do it twice and you get two unrelated folders.

N2O Sync Lite pulls the same content into your Obsidian vault as clean Markdown,
with working links, properties as frontmatter, and images on disk. Run it again
next week and it updates what changed instead of dumping a second copy.

## What comes across

Full mapping table, block by block:
[n2osync.com/docs/reference/supported-blocks](https://n2osync.com/docs/reference/supported-blocks/)

## Compared to Notion's own export

|                  | Notion Markdown export                           | N2O Sync Lite                            |
| ---------------- | ------------------------------------------------ | ---------------------------------------- |
| How you run it   | Request it, wait for an email, download a `.zip` | One command in Obsidian                  |
| Filenames        | `Page Title abc123def456...789.md`               | `Page Title.md`                          |
| Internal links   | Point at exported filenames, frequently broken   | Working `[[wikilinks]]`                  |
| Databases        | Loose CSV next to the pages                      | A folder of notes with typed frontmatter |
| Properties       | In the CSV, not on the page                      | YAML frontmatter, queryable              |
| Images           | In the zip, paths often mangled                  | Downloaded into `_files/`, links correct |
| Running it again | A second unrelated folder                        | Updates what changed                     |
| Your local edits | Overwritten or duplicated                        | Never written over                       |
| Scheduling       | Not possible                                     | Re-run whenever you want                 |

## Install

**From the Obsidian community store**

1. Open **Settings > Community plugins > Browse**
2. Search for **N2O Sync Lite**
3. Install, then Enable

## Your first sync

1. Open the N2O panel from the ribbon or the command palette
2. Choose what to sync: everything, or pick specific pages and databases
3. Run **N2O: Pull from Notion**

Start with one database or one page tree rather than the whole workspace. It
makes the first run fast and it makes it obvious what N2O is doing to your vault.

Re-running is safe. If you edited a note in Obsidian and the page also changed in
Notion, N2O does not try to combine them and does not overwrite you. Your file
stays as it is and Notion's version is written beside it as `<name>.conflict.md`,
so you can compare the two and keep what you want.

## Support

- **Docs and guides**: [n2osync.com/docs](https://n2osync.com/docs)
- **Bugs and feature requests**: [GitHub issues](https://github.com/n2osync/n2o-lite/issues)

When reporting a bug, it helps a lot if you include your Obsidian version, the
N2O version, what you were doing, and anything the developer console shows
(Ctrl+Shift+I on Windows and Linux, Cmd+Option+I on macOS).

I read everything that comes in. This is a one-person project, so response times
vary, but nothing gets ignored.

## Privacy

Full policy: [n2osync.com/docs/legal/privacy](https://n2osync.com/docs/legal/privacy/)

## Licence

MIT. See [LICENSE](LICENSE).
