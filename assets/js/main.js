/**
 * Alpine components for Vizitto.
 *
 * Logic lives here rather than in inline x-data expressions (brief section 10).
 * The catalog loads data/cards.json once and filters it in memory — fine to
 * roughly 2,000 cards, after which the JSON is split per category.
 */

/** Normalises for search: case, ё/е, and surrounding whitespace. */
function foldText(value) {
  return String(value ?? '').toLowerCase().replace(/ё/g, 'е').trim();
}

/** Collects every string on a card that free-text search should match. */
function searchIndexFor(card) {
  return foldText([
    card.title,
    card.description,
    card.address,
    card.category?.ru,
    card.subcategory?.ru,
    card.city?.ru,
    ...(card.tags ?? []),
  ].filter(Boolean).join(' '));
}

const FEATURE_LABELS = {
  delivery: 'Доставка', pickup: 'Самовывоз', wifi: 'Wi-Fi', parking: 'Парковка',
  card: 'Оплата картой', halal: 'Халяль', '24h': 'Круглосуточно',
  kids: 'Детская комната', accessible: 'Доступная среда',
};

const RATING_SOURCE_LABELS = {
  yandex: 'Яндекс.Картах', '2gis': '2ГИС', google: 'Google Картах', own: 'Vizitto',
};

/** Russian plural picker: 1 отзыв, 2 отзыва, 5 отзывов. */
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

document.addEventListener('alpine:init', () => {
  /* ----------------------------------------------------------- mobile menu */
  Alpine.data('siteNav', () => ({
    open: false,
    toggle() { this.open = !this.open; },
    close() { this.open = false; },
  }));

  /* ------------------------------------------------- home page search box */
  Alpine.data('homeSearch', () => ({
    q: '',
    submit() {
      const query = this.q.trim();
      window.location.href = query
        ? `/catalog/?q=${encodeURIComponent(query)}`
        : '/catalog/';
    },
  }));

  /* ----------------------------------------------------------- home page */
  /**
   * The home page's category tiles are static HTML so search engines see them.
   * This only fills in the per-category counts and the recent-cards strip.
   */
  Alpine.data('homeFeed', () => ({
    cards: [],
    counts: {},
    total: 0,
    loading: true,

    async init() {
      try {
        const [cards, categories] = await Promise.all([
          fetch('/data/cards.json').then((r) => r.ok ? r.json() : []),
          fetch('/data/categories.json').then((r) => r.ok ? r.json() : []),
        ]);
        this.total = cards.length;
        this.cards = cards;
        this.counts = Object.fromEntries(categories.map((c) => [c.slug, c.count]));
      } catch (err) {
        console.error('home feed load failed:', err);
      } finally {
        this.loading = false;
      }
    },

    /**
     * cards.json already arrives in the brief's sort order (section 6.8:
     * featured, then verified, then rating, then title). It is not recency —
     * most rows have no updated_at — so the heading says «Из каталога».
     */
    get highlighted() {
      return this.cards.slice(0, 6);
    },

    countFor(slug) { return this.counts[slug] ?? 0; },

    cardUrl(card) { return `/catalog/${card.slug}/`; },

    excerpt(card) {
      if (card.description) {
        return card.description.length > 120
          ? card.description.slice(0, 117).replace(/\s+\S*$/, '') + '…'
          : card.description;
      }
      return card.subcategory ? card.subcategory.ru : card.category.ru;
    },

    totalLabel() {
      return `${this.total} ${plural(this.total, 'организация', 'организации', 'организаций')}`;
    },
  }));

  /* ------------------------------------------------------------- catalog */
  Alpine.data('catalog', () => ({
    cards: [],
    categories: [],
    regions: [],
    loading: true,
    error: null,
    pageSize: 24,
    shown: 24,

    filters: { category: '', city: '', q: '' },

    async init() {
      this.readFiltersFromUrl();
      try {
        const [cards, categories, regions] = await Promise.all([
          fetch('/data/cards.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
          fetch('/data/categories.json').then((r) => r.ok ? r.json() : []),
          fetch('/data/regions.json').then((r) => r.ok ? r.json() : []),
        ]);
        this.cards = cards.map((c) => ({ ...c, _search: searchIndexFor(c) }));
        this.categories = categories.filter((c) => c.count > 0);
        this.regions = regions;
      } catch (err) {
        this.error = 'Не удалось загрузить каталог. Обновите страницу.';
        console.error('catalog load failed:', err);
      } finally {
        this.loading = false;
      }

      // x-model writes the select's value during init, before the <option>
      // elements exist, so a shared URL left the control looking unset even
      // though the filter was applied. Re-assert it now that they are rendered.
      this.$nextTick(() => this.syncSelects());

      // Back/forward should restore the filters the URL describes.
      window.addEventListener('popstate', () => {
        this.readFiltersFromUrl();
        this.shown = this.pageSize;
        this.$nextTick(() => this.syncSelects());
      });
    },

    /* --- URL state ------------------------------------------------------ */
    readFiltersFromUrl() {
      const params = new URLSearchParams(window.location.search);
      this.filters.category = params.get('category') ?? '';
      this.filters.city = params.get('city') ?? '';
      this.filters.q = params.get('q') ?? '';
    },

    /** Filter state lives in the query string so a filtered view is shareable. */
    writeFiltersToUrl() {
      const params = new URLSearchParams();
      if (this.filters.category) params.set('category', this.filters.category);
      if (this.filters.city) params.set('city', this.filters.city);
      if (this.filters.q.trim()) params.set('q', this.filters.q.trim());
      const query = params.toString();
      window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
    },

    /** Pushes filter state onto the select elements themselves. */
    syncSelects() {
      if (this.$refs.categorySelect) this.$refs.categorySelect.value = this.filters.category;
      if (this.$refs.citySelect) this.$refs.citySelect.value = this.filters.city;
    },

    onFilterChange() {
      this.shown = this.pageSize;
      this.writeFiltersToUrl();
    },

    reset() {
      this.filters = { category: '', city: '', q: '' };
      this.onFilterChange();
    },

    get hasActiveFilters() {
      return Boolean(this.filters.category || this.filters.city || this.filters.q.trim());
    },

    /* --- derived data --------------------------------------------------- */
    get cities() {
      return this.regions.flatMap((r) => r.cities ?? []);
    },

    get results() {
      const q = foldText(this.filters.q);
      const terms = q ? q.split(/\s+/).filter(Boolean) : [];
      return this.cards.filter((card) => {
        if (this.filters.category && card.category?.slug !== this.filters.category) return false;
        if (this.filters.city && card.city?.slug !== this.filters.city) return false;
        return terms.every((term) => card._search.includes(term));
      });
    },

    get visible() {
      return this.results.slice(0, this.shown);
    },

    get hasMore() {
      return this.results.length > this.shown;
    },

    showMore() {
      this.shown += this.pageSize;
    },

    get resultsLabel() {
      const n = this.results.length;
      return `${n} ${plural(n, 'организация', 'организации', 'организаций')}`;
    },

    /* --- presentation helpers ------------------------------------------ */
    cardUrl(card) { return `/catalog/${card.slug}/`; },

    /** Listings show the description's first ~120 chars, or a truthful fallback. */
    excerpt(card) {
      if (card.description) {
        return card.description.length > 120
          ? card.description.slice(0, 117).replace(/\s+\S*$/, '') + '…'
          : card.description;
      }
      return card.subcategory ? card.subcategory.ru : card.category.ru;
    },

    primaryPhone(card) { return card.contacts?.phone?.[0] ?? null; },

    featureLabel(slug) { return FEATURE_LABELS[slug] ?? slug; },

    /** Everything after the score, e.g. " · 54 отзыва на Яндекс.Картах". */
    ratingSuffix(card) {
      if (!card.rating) return '';
      const source = RATING_SOURCE_LABELS[card.rating.source] ?? card.rating.source;
      const count = card.rating.count
        ? ` · ${card.rating.count} ${plural(card.rating.count, 'отзыв', 'отзыва', 'отзывов')}`
        : '';
      return `${count} на ${source}`;
    },

    categoryIcon(slug) {
      return this.categories.find((c) => c.slug === slug)?.icon ?? 'circle-info';
    },
  }));
});
