'use strict';
const scraper = require('../sources/scraper');
const { resolveStream } = require('./interceptor');

/**
 * Média TMDB → flux lisible.
 * media = { type: 'movie'|'tv', anime?, title, originalTitle, year, season?, episode? }
 * Essaie chaque source active par ordre de priorité ; s'arrête au premier flux trouvé.
 */
async function resolveMedia(repo, media, { onProgress = () => {}, signal, matches = null } = {}) {
  let providers = repo.providersFor(media);
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
    // Trace par source : sert au diagnostic de la fiche (« pourquoi rien n'a été trouvé »).
    const trace = { provider: provider.name, providerId: provider.id, step: 'search', matched: null, link: null, pageUrl: null, playerUrl: null, log: [], error: null, ms: 0 };
    const t0 = Date.now();
    const log = (m) => { if (trace.log.length < 60) trace.log.push(`${((Date.now() - t0) / 1000).toFixed(1)} s · ${m}`); };
    const step = (msg) => { log(msg); onProgress({ provider: provider.name, message: msg }); };
    try {
      let best;
      if (known && known.providerId === provider.id) {
        best = { link: known.link, title: known.title };
        log(`Correspondance déjà connue : « ${best.title} »`);
      } else {
        step('Recherche du titre…');
        const found = await scraper.search(provider, media);
        best = found.best;
        if (!best) {
          const sample = found.results.slice(0, 5).map((r) => `« ${r.title}${r.year ? ` (${r.year})` : ''} »`).join(', ');
          throw new Error(found.results.length ? `${found.results.length} résultat(s), aucun ne correspond${sample ? ` : ${sample}` : ''}` : 'Aucun résultat');
        }
        if (matches) matches.remember(media, provider.id, best.link, best.title);
      }
      trace.matched = best.title;
      trace.link = best.link;

      let pageUrl = best.link;
      trace.step = 'page';
      if (media.type === 'tv') {
        step(`Épisode S${pad(media.season)}E${pad(media.episode)}…`);
        pageUrl = await scraper.episodeUrl(provider, best.link, media.season, media.episode);
      }
      trace.pageUrl = pageUrl;

      const player = await scraper.playerPage(provider, pageUrl);
      trace.playerUrl = player.url;
      trace.step = 'player';
      log(player.url === pageUrl ? 'Pas d\'iframe trouvée : analyse de la page elle-même' : `Lecteur : ${player.url}`);
      step('Analyse du lecteur…');
      const baseTimeout = provider.player.timeoutMs || 30000;
      const intercept = (url, ref, timeoutMs) => resolveStream(url, {
        referer: ref,
        headers: provider.headers,
        allowedHosts: provider.player.allowedHosts || [],
        extraHlsPattern: provider.player.extraHlsPattern || null,
        timeoutMs,
        signal,
        onLog: (m) => { log(m); console.log(`[resolver:${provider.id}] ${m}`); },
      });
      let found;
      try {
        found = await intercept(player.url, player.referer || pageUrl, baseTimeout);
      } catch (err) {
        if (!/délai dépassé/i.test(err.message) || (signal && signal.aborted)) throw err;
        // Second essai plus court : la page du titre elle-même si on avait isolé une iframe
        // (lecteur qui dépend de la page parente), sinon le même lecteur.
        const other = player.url !== pageUrl;
        step(other ? 'Le lecteur ne répond pas, essai sur la page du titre…' : 'Le lecteur tarde, nouvel essai…');
        found = await intercept(other ? pageUrl : player.url, other ? null : (player.referer || pageUrl), Math.round(baseTimeout * 0.7));
      }
      const { best: stream, all } = found;
      return { stream, alternatives: all, provider: { id: provider.id, name: provider.name }, matchedTitle: best.title };
    } catch (err) {
      if (signal && signal.aborted) throw new Error('Annulé');
      if (known && known.providerId === provider.id) matches.forget(media); // correspondance périmée
      console.warn(`[resolver:${provider.id}]`, err.message);
      trace.error = err.message;
      trace.ms = Date.now() - t0;
      failures.push(trace);
      onProgress({ provider: provider.name, message: `Échec : ${err.message}`, failed: true });
    }
  }
  const found = failures.some((f) => f.matched);
  const err = new Error(found ? 'Titre trouvé, mais aucun flux vidéo n\'a pu être lu.' : 'Aucune source n\'a trouvé ce titre.');
  err.code = 'ALL_FAILED';
  err.failures = failures;
  throw err;
}

const pad = (n) => String(n).padStart(2, '0');

module.exports = { resolveMedia };
