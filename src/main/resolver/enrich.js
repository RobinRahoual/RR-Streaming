'use strict';
/**
 * Ajoute les titres alternatifs TMDB à un média quand le titre seul risque de ne pas suffire :
 * animes (noms romaji : « Shingeki no Kyojin » pour « L'Attaque des Titans ») et titres originaux
 * non latins. Les titres sont ensuite utilisés pour la recherche et la correspondance.
 */
const LATIN = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u;
// Pays dont les titres alternatifs sont les plus utiles aux sites : romaji (JP), anglais, français.
const COUNTRY_ORDER = ['JP', 'US', 'GB', 'FR', 'BE', 'CA'];

function createEnricher(tmdb) {
  const cache = new Map();
  return async function enrich(media) {
    if (!media || media.tmdbId == null || media.altTitles) return media;
    const nonLatin = media.originalTitle && !LATIN.test(media.originalTitle);
    if (!media.anime && !nonLatin) return media;
    const key = `${media.type}:${media.tmdbId}`;
    if (!cache.has(key)) {
      cache.set(key, tmdb.get(`/${media.type === 'tv' ? 'tv' : 'movie'}/${media.tmdbId}/alternative_titles`).then((d) => {
        const list = (d.results || d.titles || [])
          .filter((t) => t && t.title && LATIN.test(t.title))
          .sort((a, b) => rank(a.iso_3166_1) - rank(b.iso_3166_1))
          .map((t) => t.title.trim());
        return [...new Set(list)].filter((t) => t !== media.title).slice(0, 6);
      }).catch(() => []));
      if (cache.size > 300) cache.delete(cache.keys().next().value);
    }
    const altTitles = await cache.get(key);
    return altTitles.length ? { ...media, altTitles } : media;
  };
}

function rank(country) {
  const i = COUNTRY_ORDER.indexOf(country);
  return i === -1 ? COUNTRY_ORDER.length : i;
}

module.exports = { createEnricher };
