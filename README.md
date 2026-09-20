# Vizitto

Статический каталог организаций Чечни — [vizitto.ru](https://vizitto.ru).

Полное описание проекта — в брифе (`Vizitto — Project Brief`, вне репозитория).
Здесь — только то, что нужно для работы с кодом.

---

## How it works

```
Google Sheet ──► GitHub Action (every 30 min + manual) ──► data/*.json
  (editors)        fetch CSV → validate → normalise       + catalog/{slug}/
                                                          + sitemap.xml
                                                                  │
                                                                  ▼
                                                        GitHub Pages (vizitto.ru)
```

Nothing is built locally. `scripts/build.mjs` runs inside the Action, uses only
Node 20 built-ins (`fetch`, `node:fs`), and has zero npm dependencies. Tailwind
and Alpine load from CDN at runtime, so editing a page means opening the HTML
file.

### Commands (CI only — you never need to run these)

```bash
node scripts/selftest.mjs                        # 14 assertions over the parsers
node scripts/build.mjs                           # fetch the live sheet and build
node scripts/build.mjs --fixture scripts/fixtures # build offline from committed sample rows
```

### Generated — never edit by hand

`data/*.json`, `catalog/{slug}/index.html`, `sitemap.xml`.
Card pages are rendered from `templates/card.html`; edit the template, not the
output. A card page removed from the sheet is pruned on the next build.

---

## Editing the catalog

Editors work only in the Google Sheet, tab `List`. A card needs a title, a
category, a region, a city and at least one way to contact the business.
Publishing happens within ~30 minutes, or immediately via
**Actions → Sync catalog → Run workflow**.

`data/build.json` reports every run: how many rows were read, published and
rejected, plus a numbered list of warnings. Read it after a sync — it names the
exact rows to tidy.

---

## Decisions this codebase encodes

| Decision | Why |
| --- | --- |
| **Adapter-mode validation** | The sheet still uses the pre-restructure columns, and only one row of 45 has `description`/`updated_at`. Those are optional here, so 44 cards publish now. Section 6 columns (`status`, `slug`, `city`, `features`, …) activate automatically once added — no code change. |
| **Tailwind via Play CDN** | No build step anywhere. Tokens live in the inline `tailwind.config` on each page. The brief's §8 compiled-CSS route was declined in favour of this. |
| **Alpine pinned to 3.14.1** | It was previously unpinned on unpkg. |
| **`contacts.email` added** | The sheet's `website` column mixes URLs, `@handles` and e-mail addresses. Six businesses have an e-mail as their only non-phone contact, so the contract gained a field rather than dropping them. **This extends brief §6.7.** |
| **Instagram withheld** | Parsed but not rendered, behind `DROP_INSTAGRAM` in `build.mjs`, pending the legal check in brief open question 5. |
| **Ratings need a source** | Per §6.3 a rating without `rating_source` is dropped, not shown. Both rated rows currently lack one, so no ratings render yet. |
| **Slug rule is frozen** | Cyrillic transliteration with `-ый`/`-ий` → `y` (Грозный → `grozny`). Slugs are permanent URLs; changing this rule breaks them. |
| **Quotes normalised to «ёлочки»** | Brief §10. The sheet is typed with straight quotes. |

### Design tokens

| Token | Hex | Use |
| --- | --- | --- |
| `primary` | `#0F6B47` | buttons, links |
| `primary-hover` | `#0B5438` | hover |
| `accent` | `#C77D2E` | ratings, featured |
| `ink` | `#14201B` | body text |
| `muted` | `#5C6B64` | secondary text |
| `subtle` | `#F4F7F5` | page background |
| `border` | `#DDE5E0` | borders |

Font: **Manrope** 400/500/600/700. All combinations meet WCAG AA on white.

---

## Open items

- **Sheet sharing is set to "Anyone with the link → Editor".** Anyone holding the
  URL can edit rows that publish to the live site within 30 minutes. It should be
  **Viewer**.
- **Card images are unmapped.** `assets/images/cards/{n}/` holds 91 scanned
  business cards, but `{n}` is not the sheet's `id` — folder 13 is ARTMEDIA
  (id 7) and folder 21 is ТД «Баркалла» (id 9), and the offsets differ. Attaching
  them by id printed one business's phone number and address on another's page,
  so it was removed. Fill the sheet's `image` column to restore images; until
  then every card shows the category placeholder.
- **Images are heavy.** ~950 KB per JPEG, 81 MB total, against a 300 KB
  first-load budget. Needs a WebP conversion pass before launch.
- **Vizitto's own contacts are unknown** (brief open question 1). `VIZITTO_PHONE`
  and `VIZITTO_ADDRESS` in `build.mjs` are `null`, and `/contact/` says so
  plainly rather than showing an invented number.
- **The `/add/` Google Form does not exist yet.** `/add/` explains the process and
  points at `/contact/`; the embed goes in where the page marks `TBD`.
- **`/privacy/` and `/terms/` are drafts** and need legal review before the form
  goes live.
- **~18 rows file a subcategory under the wrong category.** They publish with the
  subcategory kept and a warning logged; see `data/build.json`.

---

## Layout

```
index.html  404.html  robots.txt  sitemap.xml*  CNAME
about/ contact/ faq/ add/ privacy/ terms/     # hand-written
catalog/index.html                            # hand-written listing
catalog/{slug}/index.html*                    # generated
templates/card.html                           # source for the above
assets/css/site.css  assets/js/main.js  assets/images/
data/*.json*                                  # generated
scripts/build.mjs  scripts/selftest.mjs  scripts/fixtures/
.github/workflows/sync.yml
*.html at root (cards, about, contact, faq)   # redirect stubs to the new routes
```

`*` = generated.
