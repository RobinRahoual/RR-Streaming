'use strict';
const scraper = require('../sources/scraper');
const { resolveStream } = require('./interceptor');

/**
 * Média TMDB → flux lisible.
 * media = { type: 'movie'|'tv', title, originalTitle, year, season?, episode? }
 * Essaie chaque source active par ordre de priorité ; s'arrête au premier flux trouvé.
 */
async function resolveMedia(repo, media, { onProgress = () => {}, signal, matches = null } = {}) {
  let providers = repo.activeProviders(media.type);
  // Titre déjà trouvé (onglet Recherche, lecture précédente) : cette source passe en premier, sans nouvelle recherche.
  const known = matches ? matches.get(media) : null;
  if (known && providers.some((p) => p.id === known.providerId)) {
    providers = [providers.find((p) => p.id === known.providerId), ...providers.filter((p) => p.id !== known.providerId)];
  }
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
      let best;
      if (known && known.providerId === provider.id) {
        best = { link: known.link, title: known.title };
      } else {
        step('Recherche du titre…');
        const found = await scraper.search(provider, media);
        best = found.best;
        if (!best) throw new Error(found.results.length ? `${found.results.length} résultat(s), aucun ne correspond` : 'Aucun résultat');
        if (matches) matches.remember(media, provider.id, best.link, best.title);
      }

      let pageUrl = best.link;
      if (media.type === 'tv') {
        step(`Épisode S${pad(media.season)}E${pad(media.episode)}…`);
        pageUrl = await scraper.episodeUrl(provider, best.link, media.season, media.episode);
      }

      const player = await scraper.playerPage(provider, pageUrl);
      step('Analyse du lecteur…');
      // Le lecteur met parfois du temps à démarrer : un second essai, plus long, avant d'abandonner la source.
      const baseTimeout = provider.player.timeoutMs || 30000;
      const intercept = (timeoutMs) => resolveStream(player.url, {
        referer: player.referer || pageUrl,
        headers: provider.headers,
        allowedHosts: provider.player.allowedHosts || [],
        extraHlsPattern: provider.player.extraHlsPattern || null,
        timeoutMs,
        signal,
        onLog: (m) => console.log(`[resolver:${provider.id}] ${m}`),
      });
      let found;
      try {
        found = await intercept(baseTimeout);
      } catch (err) {
        if (!/délai dépassé/i.test(err.message) || (signal && signal.aborted)) throw err;
        step('Le lecteur tarde, nouvel essai…');
        found = await intercept(Math.round(baseTimeout * 1.5));
      }
      const { best: stream, all } = found;
      return { stream, alternatives: all, provider: { id: provider.id, name: provider.name }, matchedTitle: best.title };
    } catch (err) {
      if (signal && signal.aborted) throw new Error('Annulé');
      if (known && known.providerId === provider.id) matches.forget(media); // correspondance périmée
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
