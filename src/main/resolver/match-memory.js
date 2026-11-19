'use strict';
/**
 * Mémoire des correspondances titre TMDB → page sur une source (« Dune » → https://site/film/dune-2021).
 * Remplie par la vérification de disponibilité (onglet Recherche) et par chaque résolution :
 * la résolution suivante du même titre commence par cette source et saute la recherche.
 */
class MatchMemory {
  constructor(ttlMs = 6 * 3600 * 1000) {
    this.ttl = ttlMs;
    this.map = new Map();
  }

  static keyOf(media) { return `${media.type}:${media.tmdbId}`; }

  remember(media, providerId, link, title) {
    if (!media || media.tmdbId == null) return;
    this.map.set(MatchMemory.keyOf(media), { providerId, link, title, at: Date.now() });
  }

  get(media) {
    const m = media && media.tmdbId != null ? this.map.get(MatchMemory.keyOf(media)) : null;
    return m && Date.now() - m.at < this.ttl ? m : null;
  }

  forget(media) { this.map.delete(MatchMemory.keyOf(media)); }

  clear() { this.map.clear(); }
}

module.exports = { MatchMemory };
