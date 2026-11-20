'use strict';
/**
 * Disponibilité des résultats de recherche sur les sources (badges « Disponible / Introuvable »).
 *
 * 1. Une seule recherche par source, avec le texte tapé par l'utilisateur : tous les résultats TMDB
 *    sont comparés à cette même page (au lieu d'une recherche par résultat et par source).
 * 2. Seconde passe ciblée pour les premiers résultats non trouvés : recherche par titre, titre
 *    original et titres alternatifs (ex. nom romaji d'un anime). Les autres sont marqués introuvables.
 * Les résultats arrivent au fil de l'eau ; une nouvelle recherche annule la précédente.
 */
const scraper = require('../sources/scraper');

const keyOf = (m) => `${m.type}:${m.tmdbId}`;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

class Availability {
  constructor(repo, {
    emit = () => {},
    ttlMs = 30 * 60 * 1000,
    missTtlMs = 5 * 60 * 1000,
    concurrency = 3,
    secondPass = 6,
    fullPage = 15,
    search = scraper.search,
    searchQuery = scraper.searchQuery,
    pickBest = scraper.pickBest,
    enrich = async (m) => m,
    matches = null,
  } = {}) {
    Object.assign(this, { repo, emit, ttlMs, missTtlMs, concurrency, secondPass, fullPage, search, searchQuery, pickBest, enrich, matches });
    this.cache = new Map();
    this.generation = 0;
  }

  static keyOf(m) { return keyOf(m); }

  /**
   * Vérifie une liste de médias pour la recherche `query`.
   * Renvoie le nombre de sources utilisées (0 : rien à vérifier).
   */
  check(list, query = '') {
    const gen = ++this.generation;
    const providers = this.repo.activeProviders();
    if (!providers.length) return 0;

    const pending = [];
    for (const media of list) {
      const hit = this.cache.get(keyOf(media));
      if (hit && Date.now() - hit.at < (hit.value.available ? this.ttlMs : this.missTtlMs)) this.emit('availability:result', { key: keyOf(media), ...hit.value });
      else pending.push(media);
    }
    if (pending.length) this.#run(gen, String(query || '').trim(), pending).catch((err) => console.warn('[availability]', err));
    else this.emit('availability:done', { query, total: list.length });
    return providers.length;
  }

  cancel() { this.generation++; }

  clear() {
    this.cache.clear();
    this.generation++;
  }

  async #run(gen, query, items) {
    const alive = () => gen === this.generation;
    const t0 = Date.now();
    const done = new Set();
    const report = (media, value) => {
      if (done.has(keyOf(media))) return;
      done.add(keyOf(media));
      this.cache.set(keyOf(media), { at: Date.now(), value });
      if (alive()) this.emit('availability:result', { key: keyOf(media), ...value });
    };

    // Titres alternatifs (animes, titres non latins) : en parallèle de la recherche.
    const enriched = mapLimit(items, 4, (m) => this.enrich(m).catch(() => m));

    // 1. Une recherche par source avec le texte tapé.
    const providerIds = new Set();
    const providers = [];
    for (const m of items) for (const p of this.repo.providersFor(m)) if (!providerIds.has(p.id)) { providerIds.add(p.id); providers.push(p); }
    const pages = new Map();
    if (query) {
      await mapLimit(providers, this.concurrency, async (p) => {
        if (!alive()) return;
        try { pages.set(p.id, await this.searchQuery(p, query)); } catch { pages.set(p.id, []); }
      });
    }
    if (!alive()) return;

    const medias = await enriched;
    const missing = [];
    for (const media of medias) {
      let found = null;
      for (const p of this.repo.providersFor(media)) {
        const best = pages.has(p.id) ? this.pickBest(pages.get(p.id), media, p.match || { minScore: 0.8, yearTolerance: 1 }) : null;
        if (best) { found = { p, best }; break; }
      }
      if (found) {
        if (this.matches) this.matches.remember(media, found.p.id, found.best.link, found.best.title);
        report(media, { available: true, provider: found.p.name });
      } else {
        missing.push(media);
      }
    }

    // 2. Seconde passe, limitée aux premiers résultats (les plus pertinents pour TMDB).
    //    Inutile pour une source dont la page n'était pas pleine si le titre contient déjà tous les mots tapés :
    //    la recherche dédiée renverrait la même page.
    const words = scraper.normalizeTitle(query).split(' ').filter(Boolean);
    const coveredBy = (media, p) => {
      const page = pages.get(p.id);
      if (!page || page.length >= this.fullPage || !words.length) return false;
      const t = scraper.normalizeTitle(media.title).split(' ');
      return words.every((w) => t.includes(w));
    };
    const retry = missing.slice(0, this.secondPass);
    for (const m of missing.slice(this.secondPass)) report(m, { available: false, provider: null });
    await mapLimit(retry, Math.max(1, this.concurrency - 1), async (media) => {
      if (!alive()) return;
      for (const p of this.repo.providersFor(media)) {
        if (!alive()) return;
        if (coveredBy(media, p)) continue;
        try {
          const { best } = await this.search(p, media, { maxQueries: 2, skipQueries: query ? [query] : [] });
          if (best) {
            if (this.matches) this.matches.remember(media, p.id, best.link, best.title);
            report(media, { available: true, provider: p.name });
            return;
          }
        } catch { /* source injoignable : suivante */ }
      }
      report(media, { available: false, provider: null });
    });

    if (alive()) {
      const available = [...done].filter((k) => this.cache.get(k)?.value.available).length;
      this.emit('availability:done', { query, total: items.length, available, ms: Date.now() - t0 });
    }
  }
}

module.exports = { Availability };
