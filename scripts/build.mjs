#!/usr/bin/env node
/**
 * Vizitto catalog build.
 *
 * Fetches the Google Sheet as CSV, validates and normalises rows, then writes
 * data/*.json, the generated card pages and sitemap.xml.
 *
 * Runs on GitHub Actions only — never locally. Zero npm dependencies: Node 20+
 * built-ins (fetch, node:fs, node:path) and nothing else.
 *
 * Offline: `node scripts/build.mjs --fixture scripts/fixtures` reads list.csv
 * and helpers.csv from that directory instead of fetching.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ config */

const SHEET_ID = '1oUc3bWqXlEx1LvUggUHxZHdvexqt0P_JcdxNa8rjwFA';
// Tabs are addressed by name. Renaming a tab in the sheet breaks the build
// loudly (non-zero exit, last good site stays live) rather than silently.
const TABS = { cards: 'List', taxonomy: 'Helpers' };
const SITE_ORIGIN = 'https://vizitto.ru';

// Open question 5 in the brief: linking business Instagram profiles from a
// Russian site needs a legal check. Parsed but withheld until that is answered.
const DROP_INSTAGRAM = true;

// Open question 1 in the brief: Vizitto's own contact details are unknown.
// These stay null until answered — no invented contact details ship.
const VIZITTO_PHONE = null;   // TBD
const VIZITTO_ADDRESS = null; // TBD

// assets/images/cards/{n}/ holds 91 scanned business cards, but {n} is NOT the
// sheet's id: folder 13 is ARTMEDIA (id 7) and folder 21 is ТД "Баркалла"
// (id 9) — the offsets differ, so no mapping can be derived. Attaching them by
// id would print one business's phone number and address on another's page, so
// images come only from the sheet's `image` column. Cards without one render
// the category placeholder (brief section 6.4).
const GENERATED_MARKER = '<!-- generated:vizitto-card -->';

/* ------------------------------------------------------------------ logging */

const log = { rejected: [], warnings: [] };
const reject = (id, reason) => {
  log.rejected.push({ id: String(id ?? '?'), reason });
  console.error(`  REJECT id=${id ?? '?'}: ${reason}`);
};
const warn = (id, reason) => {
  log.warnings.push({ id: String(id ?? '?'), reason });
  console.warn(`  warn   id=${id ?? '?'}: ${reason}`);
};

/* --------------------------------------------------------------- csv parser */

/**
 * Hand-written CSV parser. Handles quoted fields, embedded commas, embedded
 * newlines inside quotes and "" escaping — all of which the real sheet uses
 * (multi-line phone and address cells).
 */
export function parseCsv(text) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = () => { row.push(field); field = ''; started = true; };
  const endRow = () => { endField(); rows.push(row); row = []; started = false; };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { quoted = true; started = true; continue; }
    if (c === ',') { endField(); continue; }
    if (c === '\r') { if (s[i + 1] === '\n') i++; endRow(); continue; }
    if (c === '\n') { endRow(); continue; }
    field += c;
    started = true;
  }
  if (started || field !== '' || row.length) endRow();

  // Drop rows that are entirely empty (trailing blank lines, spacer rows).
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/* --------------------------------------------------------- transliteration */

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function slugify(input) {
  // The -ый / -ий ending collapses to a single "y", matching the conventional
  // romanisation of Russian place names (Грозный -> grozny, not groznyy).
  // Slugs are permanent URLs, so this rule must not change once cards are live.
  const source = String(input ?? '').toLowerCase().replace(/[иы]й/g, 'y');
  let out = '';
  for (const ch of source) {
    if (Object.prototype.hasOwnProperty.call(TRANSLIT, ch)) out += TRANSLIT[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += '-';
  }
  return out.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

/* -------------------------------------------------------------- taxonomy */

/**
 * Category and subcategory slugs are fixed by section 7 of the brief ("Slugs
 * are fixed. Changing one breaks URLs and data"). The sheet's Helpers tab
 * carries only Russian labels, so the slug side lives here.
 */
const CATEGORIES = [
  ['food-drink', 'Еда и напитки', 'utensils', {
    'Кафе и кофейни': 'cafe', 'Рестораны': 'restaurant', 'Бары и пабы': 'bar',
    'Фастфуд': 'fastfood', 'Пекарни': 'bakery',
    'Магазины продуктов / супермаркеты': 'grocery', 'Сладости и кондитерские': 'confectionery',
  }],
  ['health-beauty', 'Здоровье и красота', 'heart-pulse', {
    'Аптеки': 'pharmacy', 'Клиники / медцентры': 'clinic', 'Стоматология': 'dentistry',
    'Ветеринарные клиники': 'veterinary', 'Салоны красоты': 'beauty-salon',
    'Парикмахерские': 'barbershop', 'СПА и массаж': 'spa',
  }],
  ['retail', 'Товары и розница', 'bag-shopping', {
    'Магазины одежды': 'clothing', 'Обувь': 'shoes', 'Аксессуары и украшения': 'accessories',
    'Электроника и гаджеты': 'electronics', 'Мебель и интерьер': 'furniture',
    'Книги и канцтовары': 'books-stationery', 'Спорттовары': 'sporting-goods',
  }],
  ['services', 'Услуги', 'screwdriver-wrench', {
    'Ремонт техники / электроники': 'repair', 'Автосервис и СТО': 'auto-service',
    'Юридические услуги': 'legal', 'Бухгалтерия и финансы': 'accounting',
    'Маркетинг и реклама': 'marketing', 'Обучение и курсы': 'courses',
    'IT и веб-разработка': 'it-web', 'Фотографы и видеографы': 'photo-video',
  }],
  ['real-estate', 'Жильё и недвижимость', 'house', {
    'Агентства недвижимости': 'agency', 'Строительство и ремонт': 'construction',
    'Мебель на заказ / дизайн интерьера': 'custom-furniture',
  }],
  ['entertainment', 'Развлечения и досуг', 'masks-theater', {
    'Кинотеатры': 'cinema', 'Театры / концерты / шоу': 'theatre',
    'Парки, зоопарки, аттракционы': 'parks', 'Спортзалы / фитнес-клубы': 'fitness',
    'Клубы и вечеринки': 'clubs',
  }],
  ['transport', 'Транспорт и логистика', 'truck', {
    'Такси / каршеринг': 'taxi', 'Автопрокат': 'car-rental',
    'Курьерские и транспортные компании': 'delivery-company', 'Автошколы': 'driving-school',
  }],
  ['finance', 'Финансы и страхование', 'building-columns', {
    'Банки': 'bank', 'Страховые компании': 'insurance',
    'Микрофинансы и кредитные организации': 'microfinance',
  }],
  ['education', 'Образование и наука', 'graduation-cap', {
    'Школы и детсады': 'school', 'ВУЗы / колледжи / институты': 'university',
    'Репетиторы': 'tutor', 'Научные и исследовательские центры': 'research',
  }],
  ['home-household', 'Дом и хозяйство', 'couch', {
    'Магазины бытовой химии': 'household-chemicals', 'Хозяйственные магазины': 'hardware-store',
    'Сад и огород / питомники': 'garden', 'Ремонт домов и квартир': 'renovation',
  }],
  ['travel', 'Туризм и путешествия', 'plane', {
    'Отели и гостиницы': 'hotel', 'Гостевые дома и апартаменты': 'guesthouse',
    'Турагентства': 'travel-agency', 'Экскурсионные услуги': 'excursions',
  }],
  ['other', 'Другое и местные сервисы', 'circle-info', {
    'Религиозные организации': 'religious', 'Волонтерские и НКО': 'nonprofit',
    'Публичные учреждения (музеи, библиотеки, МФЦ)': 'public-institution',
  }],
].map(([slug, ru, icon, subs]) => ({ slug, ru, icon, subs }));

// The sheet spells one category differently from the brief.
const CATEGORY_ALIASES = { 'Другое / Местные сервисы': 'Другое и местные сервисы' };

// Subcategory slugs are unique across the whole taxonomy, so a Russian label
// resolves on its own. This lets a row keep its subcategory even when the
// sheet files it under a different category than the taxonomy does.
const SUBCATEGORY_INDEX = new Map();
for (const c of CATEGORIES) {
  for (const [ru, slug] of Object.entries(c.subs)) {
    SUBCATEGORY_INDEX.set(ru, { slug, parentSlug: c.slug, parentRu: c.ru });
  }
}

// The Helpers tab's "Регионы" column is empty in the live sheet, so the region
// list is explicit here. Add a row when a new region gains its first card.
const REGIONS = { 'Чечня': 'chechnya', 'Кабардино-Балкария': 'kabardino-balkaria' };

// Controlled feature vocabulary (brief section 6, column 19). Anything in the
// sheet's services/features cell that is not on this list becomes a tag.
const FEATURES = {
  delivery: ['delivery', 'доставка'], pickup: ['pickup', 'самовывоз'],
  wifi: ['wifi', 'wi-fi', 'вайфай'], parking: ['parking', 'парковка'],
  card: ['card', 'оплата картой', 'безнал'], halal: ['halal', 'халяль'],
  '24h': ['24h', '24/7', 'круглосуточно'], kids: ['kids', 'kids area', 'детская комната'],
  accessible: ['accessible', 'доступная среда'],
};
const FEATURE_LOOKUP = new Map();
for (const [slug, aliases] of Object.entries(FEATURES)) {
  for (const a of aliases) FEATURE_LOOKUP.set(a.toLowerCase(), slug);
}

const RATING_SOURCES = { yandex: 'Яндекс.Картах', '2gis': '2ГИС', google: 'Google Картах', own: 'Vizitto' };

/* ---------------------------------------------------------------- helpers */

const clean = (v) => String(v ?? '').replace(/ /g, ' ').trim();
const nullIfEmpty = (v) => { const c = clean(v); return c === '' || c === '-' ? null : c; };
/**
 * Russian typography (brief section 10): the sheet is typed with straight
 * quotes, the site sets «ёлочки». Pairs are converted in order; an unmatched
 * quote is left alone rather than guessed at.
 */
export function typographize(text) {
  if (!text) return text;
  const parts = String(text).split('"');
  if (parts.length < 3 || parts.length % 2 === 0) return text;
  return parts.reduce((acc, part, i) =>
    i === 0 ? part : acc + (i % 2 === 1 ? '«' : '»') + part, '');
}

const splitList = (v) => clean(v).split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
// Addresses legitimately contain commas, so only newlines separate entries.
const splitLines = (v) => clean(v).split(/\n+/).map((s) => s.trim()).filter(Boolean);

/** Google's gviz export can hand back a long numeric cell as 8.9287895730E10. */
function undoScientific(raw) {
  const s = clean(raw);
  const m = /^(\d(?:\.\d+)?)E\+?(\d+)$/i.exec(s);
  if (!m) return s;
  const n = Number(s);
  return Number.isFinite(n) ? n.toFixed(0) : s;
}

export function normalisePhone(raw) {
  const digits = undoScientific(raw).replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) return '+7' + digits.slice(1);
  if (digits.length === 10) return '+7' + digits;
  return null;
}

/* -------------------------------------------------------------- contacts */

/**
 * The `website` column in the live sheet is a junk drawer: real URLs, Telegram
 * handles, e-mail addresses and one Instagram link. Route each value to the
 * field it belongs in rather than emitting a broken link.
 */
const TELEGRAM_HANDLE = /^[A-Za-z0-9_]{5,32}$/;

function routeContact(value, contacts, id) {
  const v = clean(value);
  if (!v) return;

  if (v.startsWith('@')) {
    const handle = v.slice(1);
    if (TELEGRAM_HANDLE.test(handle)) contacts.telegram ??= handle;
    else warn(id, `"${v}" is not a valid Telegram handle — dropped rather than linked`);
    return;
  }
  if (/(^|\/\/|\.)instagram\.com\//i.test(v) || /^instagram\.com\//i.test(v)) {
    if (DROP_INSTAGRAM) warn(id, `instagram link withheld pending legal check: ${v}`);
    else contacts.instagram ??= v.startsWith('http') ? v : `https://${v}`;
    return;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { contacts.email ??= v; return; }
  if (/^https?:\/\//i.test(v)) { contacts.website ??= v; return; }
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) { contacts.website ??= `https://${v}`; return; }
  if (/^t\.me\//i.test(v)) { contacts.telegram ??= v.replace(/^t\.me\//i, ''); return; }

  warn(id, `unroutable contact value dropped: ${v}`);
}

function normaliseWhatsapp(raw) {
  const v = clean(raw);
  if (!v) return null;
  const m = /wa\.me\/(\d+)/i.exec(v);
  return m ? normalisePhone(m[1]) : normalisePhone(v);
}

/* ------------------------------------------------------------------ fetch */

async function fetchCsv(tabName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`
    + `?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      if (/^\s*</.test(text)) throw new Error('got HTML, not CSV — is the sheet shared with "Anyone with the link"?');
      return text;
    } catch (err) {
      lastError = err;
      console.error(`  fetch "${tabName}" attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw new Error(`could not fetch tab "${tabName}": ${lastError.message}`);
}

async function loadTab(which, fixtureDir) {
  if (fixtureDir) {
    const file = join(ROOT, fixtureDir, which === 'cards' ? 'list.csv' : 'helpers.csv');
    console.log(`  reading fixture ${file}`);
    return readFileSync(file, 'utf8');
  }
  return fetchCsv(TABS[which]);
}

/* ------------------------------------------------------- header mapping */

/**
 * Adapter mode. The live sheet still uses the pre-restructure column set, so
 * accept both spellings and treat any absent column as null for every row.
 * When the sheet gains the section 6 columns they light up with no code change.
 */
const COLUMN_ALIASES = {
  city: ['city', 'subregion'],
  features: ['features', 'services'],
};

function buildHeaderMap(headerRow) {
  const map = new Map();
  headerRow.forEach((name, i) => {
    const key = clean(name).toLowerCase().replace(/\s+/g, '_');
    if (key && !map.has(key)) map.set(key, i);
  });
  if (!map.has('title') || !map.has('id')) {
    throw new Error(`header row is missing required columns (found: ${[...map.keys()].join(', ') || 'nothing'})`);
  }
  return map;
}

function cellReader(headerMap) {
  return (row, name) => {
    const names = COLUMN_ALIASES[name] ?? [name];
    for (const n of names) {
      if (headerMap.has(n)) {
        const v = row[headerMap.get(n)];
        if (clean(v) !== '') return clean(v);
      }
    }
    return '';
  };
}

/* ----------------------------------------------------------- taxonomy read */

function readTaxonomy(csvText) {
  const rows = parseCsv(csvText);
  const known = { categories: new Set(), subcategories: new Set(), cities: new Set() };
  // Layout: Категории | Подкатегории | Регионы | Города поселоки, with the
  // category name present only on its first subcategory row.
  for (const row of rows.slice(1)) {
    const cat = clean(row[0]);
    const sub = clean(row[1]);
    const city = clean(row[3]);
    if (cat && !cat.startsWith('Основная')) known.categories.add(cat);
    if (sub && sub !== '-' && !sub.startsWith('Подкатегория..')) known.subcategories.add(sub);
    if (city) known.cities.add(city);
  }
  return known;
}

/* --------------------------------------------------------------- row parse */

function buildCard(row, cell, ctx) {
  const id = cell(row, 'id');
  const title = typographize(nullIfEmpty(cell(row, 'title')));

  // --- hard rejects -------------------------------------------------------
  const status = nullIfEmpty(cell(row, 'status'));
  if (status && status.toLowerCase() !== 'published') {
    reject(id, `status is "${status}", not published`);
    return null;
  }
  if (!title) { reject(id, 'missing required field: title'); return null; }

  // --- contacts -----------------------------------------------------------
  const contacts = { phone: [], whatsapp: null, telegram: null, vk: null, email: null, website: null };

  for (const raw of splitList(cell(row, 'phone'))) {
    const p = normalisePhone(raw);
    if (p) { if (!contacts.phone.includes(p)) contacts.phone.push(p); }
    else warn(id, `unparseable phone dropped: ${raw}`);
  }
  contacts.whatsapp = normaliseWhatsapp(cell(row, 'whatsapp'));
  const tg = nullIfEmpty(cell(row, 'telegram'))?.replace(/^@/, '');
  if (tg) {
    if (TELEGRAM_HANDLE.test(tg)) contacts.telegram = tg;
    else warn(id, `telegram "${tg}" is not a valid handle — dropped`);
  }
  const vk = nullIfEmpty(cell(row, 'vk'));
  if (vk) contacts.vk = /^https?:\/\//i.test(vk) ? vk : `https://${vk.replace(/^\/+/, '')}`;
  for (const value of splitLines(cell(row, 'website'))) routeContact(value, contacts, id);

  const hasContact = contacts.phone.length > 0 || contacts.whatsapp || contacts.telegram
    || contacts.website || contacts.email;
  if (!hasContact) { reject(id, 'no contact method (phone/whatsapp/telegram/website/email all empty)'); return null; }

  // --- taxonomy -----------------------------------------------------------
  const catRu0 = nullIfEmpty(cell(row, 'category'));
  const catRu = catRu0 ? (CATEGORY_ALIASES[catRu0] ?? catRu0) : null;
  const category = CATEGORIES.find((c) => c.ru === catRu);
  if (!category) { reject(id, `unknown category: ${catRu0 ?? '(empty)'}`); return null; }

  let subcategory = null;
  const subRu = nullIfEmpty(cell(row, 'subcategory'));
  if (subRu === 'Подкатегория') {
    warn(id, 'subcategory is the placeholder text "Подкатегория" — dropped');
  } else if (subRu) {
    const hit = SUBCATEGORY_INDEX.get(subRu);
    if (!hit) {
      warn(id, `unknown subcategory "${subRu}" — dropped`);
    } else {
      // Subcategory is a secondary filter with no UI yet (brief section 7). When
      // the sheet's category and subcategory disagree, keep both: the editor's
      // explicit category drives the primary filter, and the warning names the
      // row to tidy rather than silently discarding data.
      subcategory = { slug: hit.slug, ru: subRu };
      if (hit.parentSlug !== category.slug) {
        warn(id, `subcategory "${subRu}" sits under "${hit.parentRu}" in the taxonomy, not "${category.ru}" — kept, please align the sheet`);
      }
    }
  }

  const regionRu = nullIfEmpty(cell(row, 'region'));
  const regionSlug = regionRu ? REGIONS[regionRu] : null;
  if (regionRu && !regionSlug) { reject(id, `unknown region: ${regionRu} (add it to REGIONS in build.mjs)`); return null; }
  if (!regionRu) { reject(id, 'missing required field: region'); return null; }

  let cityRu = nullIfEmpty(cell(row, 'city'));
  if (!cityRu) { reject(id, 'missing required field: city'); return null; }
  // The sheet contains at least one lowercase spelling ("грозный").
  const cityFixed = cityRu.charAt(0).toUpperCase() + cityRu.slice(1);
  if (cityFixed !== cityRu) { warn(id, `city case normalised: "${cityRu}" -> "${cityFixed}"`); cityRu = cityFixed; }
  if (ctx.known.cities.size && !ctx.known.cities.has(cityRu)) {
    warn(id, `city "${cityRu}" is not in the Helpers tab city list`);
  }

  // --- features and tags --------------------------------------------------
  const features = [];
  const tags = splitList(cell(row, 'tags'));
  for (const raw of splitList(cell(row, 'features'))) {
    const slug = FEATURE_LOOKUP.get(raw.toLowerCase());
    if (slug) { if (!features.includes(slug)) features.push(slug); }
    else if (!tags.includes(raw)) tags.push(raw);
  }

  // --- rating -------------------------------------------------------------
  // Section 6.3: rating_source is mandatory whenever rating is filled. A rating
  // without a stated source is an invented number, so it is dropped, not shown.
  let rating = null;
  const ratingRaw = nullIfEmpty(cell(row, 'rating'));
  if (ratingRaw) {
    const value = Number(ratingRaw.replace(',', '.'));
    const source = nullIfEmpty(cell(row, 'rating_source'))?.toLowerCase() ?? null;
    if (!Number.isFinite(value) || value < 0 || value > 5) {
      warn(id, `rating "${ratingRaw}" is out of range 0.0-5.0 — dropped`);
    } else if (!source) {
      warn(id, `rating ${value} has no rating_source — dropped (brief section 6.3)`);
    } else if (!RATING_SOURCES[source]) {
      warn(id, `unknown rating_source "${source}" — rating dropped`);
    } else {
      const countRaw = nullIfEmpty(cell(row, 'reviews_count'));
      const count = countRaw ? Number.parseInt(countRaw, 10) : null;
      rating = { value, count: Number.isFinite(count) ? count : null, source };
    }
  }

  // --- price level --------------------------------------------------------
  let priceLevel = null;
  const priceRaw = nullIfEmpty(cell(row, 'price_level'));
  if (priceRaw) {
    const n = Number.parseInt(priceRaw, 10);
    if (n >= 1 && n <= 4) priceLevel = n;
    else warn(id, `price_level "${priceRaw}" is outside 1-4 — dropped`);
  }

  // --- image --------------------------------------------------------------
  let image = nullIfEmpty(cell(row, 'image'));
  if (image && !/^(https?:)?\/\//i.test(image) && !image.startsWith('/')) image = '/' + image;

  // --- slug ---------------------------------------------------------------
  let slug = nullIfEmpty(cell(row, 'slug')) ?? slugify(title);
  if (!slug) { reject(id, `could not derive a slug from title "${title}"`); return null; }
  if (ctx.slugs.has(slug)) {
    const base = slug;
    let n = 2;
    while (ctx.slugs.has(`${base}-${n}`)) n++;
    slug = `${base}-${n}`;
    warn(id, `slug "${base}" already taken — using "${slug}"`);
  }
  ctx.slugs.add(slug);

  const boolOf = (name) => {
    const v = nullIfEmpty(cell(row, name));
    return v ? /^(true|yes|да|1)$/i.test(v) : false;
  };

  return {
    id: id ? (Number.isFinite(Number(id)) ? Number(id) : id) : null,
    slug,
    title,
    category: { slug: category.slug, ru: category.ru },
    subcategory,
    region: { slug: regionSlug, ru: regionRu },
    city: { slug: slugify(cityRu), ru: cityRu },
    address: nullIfEmpty(cell(row, 'address')),
    map_url: nullIfEmpty(cell(row, 'map_url')),
    contacts,
    image,
    description: typographize(nullIfEmpty(cell(row, 'description'))),
    tags,
    features,
    hours: {
      mon_fri: nullIfEmpty(cell(row, 'hours_mon_fri')),
      sat_sun: nullIfEmpty(cell(row, 'hours_sat_sun')),
      note: nullIfEmpty(cell(row, 'hours_note')),
    },
    price_level: priceLevel,
    rating,
    verified: boolOf('verified'),
    featured: boolOf('featured'),
    updated_at: nullIfEmpty(cell(row, 'updated_at')),
  };
}

/* ------------------------------------------------------------------ sort */

// Section 6.8: featured desc -> verified desc -> rating desc -> reviews desc -> title asc.
const collator = new Intl.Collator('ru');
function sortCards(cards) {
  return cards.sort((a, b) =>
    Number(b.featured) - Number(a.featured)
    || Number(b.verified) - Number(a.verified)
    || (b.rating?.value ?? -1) - (a.rating?.value ?? -1)
    || (b.rating?.count ?? -1) - (a.rating?.count ?? -1)
    || collator.compare(a.title, b.title));
}

/* -------------------------------------------------------------- rendering */

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const escapeAttr = escapeHtml;

/** Meta descriptions want 140-160 chars of real sentence, never placeholder text. */
function metaDescription(card) {
  const where = `${card.category.ru} в городе ${card.city.ru}`;
  if (card.description) {
    const base = `${card.title} — ${where}. ${card.description}`;
    return base.length <= 160 ? base : base.slice(0, 157).replace(/\s+\S*$/, '') + '…';
  }
  const contact = card.contacts.phone.length ? 'Телефон, адрес и часы работы' : 'Контакты и адрес';
  return `${card.title} — ${where}. ${contact} на Vizitto, каталоге организаций Чечни.`;
}

function pageTitle(card) {
  const full = `${card.title} — ${card.category.ru} в ${card.city.ru} | Vizitto`;
  return full.length <= 60 ? full : `${card.title} — ${card.city.ru} | Vizitto`;
}

function jsonLd(card) {
  const node = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: card.title,
    url: `${SITE_ORIGIN}/catalog/${card.slug}/`,
  };
  if (card.description) node.description = card.description;
  if (card.image) node.image = card.image.startsWith('/') ? SITE_ORIGIN + card.image : card.image;
  if (card.contacts.phone.length) node.telephone = card.contacts.phone;
  if (card.contacts.email) node.email = card.contacts.email;
  if (card.address || card.city.ru) {
    node.address = { '@type': 'PostalAddress', addressLocality: card.city.ru, addressRegion: card.region.ru, addressCountry: 'RU' };
    if (card.address) node.address.streetAddress = card.address;
  }
  if (card.contacts.website) node.sameAs = [card.contacts.website];
  const hours = [];
  if (card.hours.mon_fri && card.hours.mon_fri !== 'closed') hours.push(`Mo-Fr ${card.hours.mon_fri === '24h' ? '00:00-23:59' : card.hours.mon_fri}`);
  if (card.hours.sat_sun && card.hours.sat_sun !== 'closed') hours.push(`Sa-Su ${card.hours.sat_sun === '24h' ? '00:00-23:59' : card.hours.sat_sun}`);
  if (hours.length) node.openingHours = hours;
  if (card.rating && card.rating.count) {
    node.aggregateRating = {
      '@type': 'AggregateRating', ratingValue: card.rating.value,
      reviewCount: card.rating.count, bestRating: 5,
    };
  }
  if (card.price_level) node.priceRange = '₽'.repeat(card.price_level);
  return JSON.stringify(node, null, 2);
}

function contactsHtml(card) {
  const rows = [];
  const item = (icon, label, href, text, extra = '') => rows.push(
    `        <li class="flex items-start gap-3">
          <i class="fa-solid fa-${icon} mt-1 w-4 text-muted" aria-hidden="true"></i>
          <span class="sr-only">${escapeHtml(label)}</span>
          ${href ? `<a class="text-primary hover:text-primary-hover underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded" href="${escapeAttr(href)}"${extra}>${escapeHtml(text)}</a>` : `<span>${escapeHtml(text)}</span>`}
        </li>`);

  for (const p of card.contacts.phone) item('phone', 'Телефон', `tel:${p}`, p);
  if (card.contacts.whatsapp) item('comment', 'WhatsApp', `https://wa.me/${card.contacts.whatsapp.replace('+', '')}`, 'WhatsApp', ' rel="noopener" target="_blank"');
  if (card.contacts.telegram) item('paper-plane', 'Telegram', `https://t.me/${card.contacts.telegram}`, `@${card.contacts.telegram}`, ' rel="noopener" target="_blank"');
  if (card.contacts.email) item('envelope', 'Электронная почта', `mailto:${card.contacts.email}`, card.contacts.email);
  if (card.contacts.website) item('globe', 'Сайт', card.contacts.website, card.contacts.website.replace(/^https?:\/\//, '').replace(/\/$/, ''), ' rel="noopener" target="_blank"');
  if (card.contacts.vk) item('v', 'ВКонтакте', card.contacts.vk, 'ВКонтакте', ' rel="noopener" target="_blank"');
  if (card.address) item('location-dot', 'Адрес', card.map_url, card.address, card.map_url ? ' rel="noopener" target="_blank"' : '');
  else if (card.map_url) item('location-dot', 'На карте', card.map_url, 'Посмотреть на карте', ' rel="noopener" target="_blank"');

  return rows.join('\n');
}

function detailsHtml(card) {
  const blocks = [];
  const { mon_fri, sat_sun, note } = card.hours;
  if (mon_fri || sat_sun || note) {
    const line = (label, v) => v ? `          <div class="flex justify-between gap-4 py-1"><dt class="text-muted">${label}</dt><dd class="font-medium">${escapeHtml(v === '24h' ? 'круглосуточно' : v === 'closed' ? 'выходной' : v)}</dd></div>` : '';
    blocks.push(`      <section class="rounded-lg border border-border bg-white p-5">
        <h2 class="mb-3 text-base font-semibold">Часы работы</h2>
        <dl class="text-sm">
${[line('Пн–Пт', mon_fri), line('Сб–Вс', sat_sun)].filter(Boolean).join('\n')}
        </dl>
${note ? `        <p class="mt-3 text-sm text-muted">${escapeHtml(note)}</p>` : ''}
      </section>`);
  }
  if (card.rating) {
    const src = RATING_SOURCES[card.rating.source];
    const count = card.rating.count ? ` · ${card.rating.count} ${plural(card.rating.count, 'отзыв', 'отзыва', 'отзывов')}` : '';
    blocks.push(`      <section class="rounded-lg border border-border bg-white p-5">
        <h2 class="mb-2 text-base font-semibold">Оценка</h2>
        <p class="text-sm"><span class="text-lg font-semibold text-accent">${card.rating.value.toFixed(1)}</span>${escapeHtml(count)} на ${escapeHtml(src)}</p>
      </section>`);
  }
  if (card.features.length) {
    const labels = { delivery: 'Доставка', pickup: 'Самовывоз', wifi: 'Wi-Fi', parking: 'Парковка', card: 'Оплата картой', halal: 'Халяль', '24h': 'Круглосуточно', kids: 'Детская комната', accessible: 'Доступная среда' };
    blocks.push(`      <section class="rounded-lg border border-border bg-white p-5">
        <h2 class="mb-3 text-base font-semibold">Особенности</h2>
        <ul class="flex flex-wrap gap-2">
${card.features.map((f) => `          <li class="rounded border border-border bg-subtle px-2.5 py-1 text-sm">${escapeHtml(labels[f] ?? f)}</li>`).join('\n')}
        </ul>
      </section>`);
  }
  return blocks.join('\n');
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function renderCardPage(card, template) {
  const url = `${SITE_ORIGIN}/catalog/${card.slug}/`;
  const desc = metaDescription(card);
  const tokens = {
    TITLE: escapeHtml(pageTitle(card)),
    META_DESCRIPTION: escapeAttr(desc),
    CANONICAL: url,
    OG_IMAGE: card.image ? (card.image.startsWith('/') ? SITE_ORIGIN + card.image : card.image) : `${SITE_ORIGIN}/assets/images/og-default.jpg`,
    JSONLD: jsonLd(card),
    NAME: escapeHtml(card.title),
    CATEGORY_RU: escapeHtml(card.category.ru),
    CATEGORY_SLUG: card.category.slug,
    CITY_RU: escapeHtml(card.city.ru),
    CITY_SLUG: card.city.slug,
    DESCRIPTION_HTML: card.description
      ? `<p class="mt-4 text-[15px] leading-relaxed text-ink">${escapeHtml(card.description)}</p>`
      : '',
    // No image means no block at all: a full-width empty placeholder on a
    // detail page is worse than starting with the business name. The listing
    // grid still shows a placeholder, where it keeps the tiles aligned.
    IMAGE_BLOCK: card.image
      ? `<div class="mb-5 aspect-[3/2] w-full overflow-hidden rounded-lg bg-subtle">
            <img src="${escapeAttr(card.image)}" alt="${escapeAttr(card.title)}" width="1200" height="800" loading="lazy" class="h-full w-full object-cover">
          </div>`
      : '',
    CONTACTS_HTML: contactsHtml(card),
    DETAILS_HTML: detailsHtml(card),
    UPDATED_HTML: card.updated_at
      ? `<p class="mt-8 text-xs text-muted">Данные обновлены: ${escapeHtml(card.updated_at)}</p>`
      : '',
    VERIFIED_HTML: card.verified
      ? '<span class="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Контакты проверены</span>'
      : '',
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : m);
}

/* ------------------------------------------------------------------ write */

function writeJson(relPath, value) {
  const file = join(ROOT, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
  console.log(`  wrote ${relPath}`);
}

/** Remove card directories this build no longer produces, leaving hand-written pages alone. */
function pruneCardPages(keepSlugs) {
  const catalogDir = join(ROOT, 'catalog');
  if (!existsSync(catalogDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(catalogDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || keepSlugs.has(entry.name)) continue;
    const index = join(catalogDir, entry.name, 'index.html');
    if (!existsSync(index)) continue;
    if (!readFileSync(index, 'utf8').includes(GENERATED_MARKER)) continue;
    rmSync(join(catalogDir, entry.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

function buildSitemap(cards) {
  const staticRoutes = ['/', '/catalog/', '/about/', '/contact/', '/faq/', '/add/', '/privacy/', '/terms/'];
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    ...staticRoutes.map((r) => ({ loc: SITE_ORIGIN + r, lastmod: today, priority: r === '/' ? '1.0' : '0.6' })),
    ...cards.map((c) => ({ loc: `${SITE_ORIGIN}/catalog/${c.slug}/`, lastmod: c.updated_at ?? today, priority: '0.8' })),
  ];
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n')
    + '\n</urlset>\n';
}

/* ------------------------------------------------------------------- main */

async function main() {
  const fixtureArg = process.argv.indexOf('--fixture');
  const fixtureDir = fixtureArg !== -1 ? process.argv[fixtureArg + 1] : null;
  const startedAt = new Date().toISOString();

  console.log(fixtureDir ? `Vizitto build (fixture: ${fixtureDir})` : 'Vizitto build (live sheet)');

  const [cardsCsv, helpersCsv] = await Promise.all([
    loadTab('cards', fixtureDir),
    loadTab('taxonomy', fixtureDir),
  ]);

  const known = readTaxonomy(helpersCsv);
  console.log(`  taxonomy: ${known.categories.size} categories, ${known.subcategories.size} subcategories, ${known.cities.size} cities`);

  const rows = parseCsv(cardsCsv);
  if (rows.length < 2) throw new Error('cards tab has no data rows');
  const headerMap = buildHeaderMap(rows[0]);
  const cell = cellReader(headerMap);
  console.log(`  columns: ${[...headerMap.keys()].join(', ')}`);
  console.log(`  parsing ${rows.length - 1} data rows`);

  const ctx = { known, slugs: new Set() };
  const cards = sortCards(rows.slice(1).map((r) => buildCard(r, cell, ctx)).filter(Boolean));

  // --- aggregates ---------------------------------------------------------
  const categories = CATEGORIES.map((c) => ({
    slug: c.slug,
    ru: c.ru,
    icon: c.icon,
    count: cards.filter((card) => card.category.slug === c.slug).length,
    subcategories: Object.entries(c.subs).map(([ru, slug]) => ({
      slug, ru, count: cards.filter((card) => card.subcategory?.slug === slug).length,
    })),
  }));

  const regions = Object.entries(REGIONS).map(([ru, slug]) => {
    const inRegion = cards.filter((c) => c.region.slug === slug);
    const cities = new Map();
    for (const c of inRegion) {
      const e = cities.get(c.city.slug) ?? { slug: c.city.slug, ru: c.city.ru, count: 0 };
      e.count++;
      cities.set(c.city.slug, e);
    }
    return {
      slug, ru, count: inRegion.length,
      cities: [...cities.values()].sort((a, b) => b.count - a.count || collator.compare(a.ru, b.ru)),
    };
  }).filter((r) => r.count > 0);

  // --- card pages ---------------------------------------------------------
  const templateFile = join(ROOT, 'templates/card.html');
  let generated = 0;
  let pruned = 0;
  if (existsSync(templateFile)) {
    const template = readFileSync(templateFile, 'utf8');
    for (const card of cards) {
      const dir = join(ROOT, 'catalog', card.slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), renderCardPage(card, template), 'utf8');
      generated++;
    }
    pruned = pruneCardPages(new Set(cards.map((c) => c.slug)));
    console.log(`  wrote ${generated} card pages, pruned ${pruned}`);
  } else {
    console.warn('  templates/card.html not found — skipping card page generation');
  }

  // --- outputs ------------------------------------------------------------
  writeJson('data/cards.json', cards);
  writeJson('data/categories.json', categories);
  writeJson('data/regions.json', regions);
  writeJson('data/build.json', {
    generated_at: startedAt,
    source: fixtureDir ? `fixture:${fixtureDir}` : `sheet:${SHEET_ID}`,
    counts: {
      rows_read: rows.length - 1,
      published: cards.length,
      rejected: log.rejected.length,
      warnings: log.warnings.length,
      card_pages: generated,
      pruned_pages: pruned,
      without_image: cards.filter((c) => !c.image).length,
    },
    rejected: log.rejected,
    warnings: log.warnings,
  });

  writeFileSync(join(ROOT, 'sitemap.xml'), buildSitemap(cards), 'utf8');
  console.log('  wrote sitemap.xml');

  console.log(`\nDone: ${cards.length} published, ${log.rejected.length} rejected, ${log.warnings.length} warnings.`);
}

// Only run when executed directly, so the helpers above stay importable by
// scripts/selftest.mjs without kicking off a build.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nFATAL: ${err.message}`);
    console.error('No files written — the last good site stays live.');
    process.exit(1);
  });
}
