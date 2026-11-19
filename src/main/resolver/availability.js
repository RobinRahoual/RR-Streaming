'use strict';
/**
 * Vérification légère de disponibilité pour les résultats de recherche :
 * le titre est-il trouvé sur au moins une source active ? (recherche seulement, sans extraction du flux)
 * Résultats envoyés au fur et à mesure ; une nouvelle recherche annule les vérifications en attente.
 */
const scraper = require('../sources/scraper');

class Availability {
  constructor(repo, { emit = () => {}, ttlMs = 30 * 60 * 1000, concurrency = 2, search = scraper.search, matches = null } = {}) {
    this.repo = repo;
    this.matches = matches;
    this.emit = emit;
    this.ttl = ttlMs;
    this.concurrency = concurrency;
    this.search = search;
    this.cache = new Map();
    this.queue = [];
    this.running = 0;
    this.generation = 0;
  }

  static keyOf(m) { return `${m.type}:${m.tmdbId}`; }

  /** Lance la vérification d'une liste de médias ; renvoie le nombre de sources utilisées (0 = rien à vérifier). */
  check(list) {
    const gen = ++this.generation;
    this.queue = [];
    const anySource = this.repo.activeProviders().length > 0;
    if (!anySource) return 0;
    for (const media of list) {
      const key = Availability.keyOf(media);
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < this.ttl) this.emit('availability:result', { key, ...hit.value });
      else this.queue.push({ media, key, gen });
    }
    this.#pump();
    return this.repo.activeProviders().length;
  }

  /** Quitter la recherche : les vérifications en attente sont abandonnées. */
  cancel() {
    this.queue = [];
    this.generation++;
  }

  clear() {
    this.cache.clear();
    this.queue = [];
    this.generation++;
  }

  #pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      if (job.gen !== this.generation) continue;
      this.running++;
      this.#run(job).finally(() => {
        this.running--;
        this.#pump();
      });
    }
  }

  async #run({ media, key }) {
    let value = { available: false, provider: null };
    for (const provider of this.repo.activeProviders(media.type)) {
      try {
        const { best } = await this.search(provider, media);
        if (best) {
          value = { available: true, provider: provider.name };
          if (this.matches) this.matches.remember(media, provider.id, best.link, best.title); // réutilisé par « Lire »
          break;
        }
      } catch { /* source injoignable : on essaie la suivante */ }
    }
    this.cache.set(key, { at: Date.now(), value });
    this.emit('availability:result', { key, ...value });
  }
}

module.exports = { Availability };
