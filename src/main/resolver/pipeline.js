'use strict';
const scraper = require('../sources/scraper');
const { resolveStream } = require('./interceptor');

/**
 * Média TMDB → flux lisible.
 * media = { type: 'movie'|'tv', title, originalTitle, year, season?, episode? }
 * Essaie chaque source active par ordre de priorité ; s'arrête au premier flux trouvé.
 */
async function resolveMedia(repo, media, { onProgress = () => {}, signal } = {}) {
  const providers = repo.activeProviders(media.type);
  if (!providers.length) {
    const err = new Error('Aucune source active pour ce type de contenu. Ajoutez-en dans l\'onglet Sources.');
    err.code = 'NO_SOURCES';
    throw err;
  }

  const failures = [];
  for (const provider of providers) {
    if (signal && signal.aborted) throw new Error('Annulé');
    const step = (msg) => onProgress({ provider: provider.name, message: msg });
    try {
      step('Recherche du titre…');
      const { best, results } = await scraper.search(provider, media);
      if (!best) throw new Error(results.length ? `${results.length} résultat(s), aucun ne correspond` : 'Aucun résultat');

      let pageUrl = best.link;
      if (media.type === 'tv') {
        step(`Épisode S${pad(media.season)}E${pad(media.episode)}…`);
        pageUrl = await scraper.episodeUrl(provider, best.link, media.season, media.episode);
      }

      const player = await scraper.playerPage(provider, pageUrl);
      step('Analyse du lecteur…');
      const { best: stream, all } = await resolveStream(player.url, {
        referer: player.referer || pageUrl,
        headers: provider.headers,
        allowedHosts: provider.player.allowedHosts || [],
        extraHlsPattern: provider.player.extraHlsPattern || null,
        timeoutMs: provider.player.timeoutMs || 20000,
        signal,
        onLog: (m) => console.log(`[resolver:${provider.id}] ${m}`),
      });
      return { stream, alternatives: all, provider: { id: provider.id, name: provider.name }, matchedTitle: best.title };
    } catch (err) {
      if (signal && signal.aborted) throw new Error('Annulé');
      console.warn(`[resolver:${provider.id}]`, err.message);
      failures.push({ provider: provider.name, error: err.message });
      onProgress({ provider: provider.name, message: `Échec : ${err.message}`, failed: true });
    }
  }
  const err = new Error('Aucune source n\'a fourni de flux lisible.');
  err.code = 'ALL_FAILED';
  err.failures = failures;
  throw err;
}

const pad = (n) => String(n).padStart(2, '0');

module.exports = { resolveMedia };
