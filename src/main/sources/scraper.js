'use strict';
const cheerio = require('cheerio');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ------------------------------------------------------------ Extraction

/** Applique un sélecteur { css, attr, regex, template } à un élément cheerio. */
function extract($, el, sel, baseUrl) {
  if (!sel) return null;
  const target = sel.css && sel.css.trim() ? $(el).find(sel.css).first() : $(el);
  if (!target.length) return null;
  const attr = sel.attr || 'text';
  let value;
  if (attr === 'text') value = target.text();
  else if (attr === 'html') value = target.html();
  else {
    value = target.attr(attr);
    if (value && /^(href|src|data-src|data-href|data-url|poster)$/i.test(attr)) {
      try { value = new URL(value, baseUrl).toString(); } catch { /* garde la valeur brute */ }
    }
  }
  if (value == null) return null;
  value = String(value).replace(/\s+/g, ' ').trim();
  if (sel.regex) {
    const m = value.match(new RegExp(sel.regex));
    if (!m) return null;
    value = (m[1] ?? m[0]).trim();
  }
  // Modèle : construit une adresse à partir d'un identifiant (« https://site/details/{value} »)
  if (value && sel.template) {
    value = String(sel.template).replace(/\{value\}/g, encodeURI(value));
    try { value = new URL(value, baseUrl).toString(); } catch { /* garde la valeur */ }
  }
  return value || null;
}

// ------------------------------------------------------------ Correspondance des titres

function normalizeTitle(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' et ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|le|la|les|l|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Coefficient de Dice sur bigrammes (0..1). */
function dice(x, y) {
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) || 0;
    if (n > 0) { grams.set(g, n - 1); hits++; }
  }
  return (2 * hits) / (x.length - 1 + y.length - 1);
}

// Mots ajoutés par les sites autour du titre (« Dune (2021) VF HD en streaming »).
const NOISE = /\b(vf|vff|vfq|vo|vost|vostfr|subfrench|truefrench|french|multi|hd|fhd|uhd|4k|hdr|1080p?|720p?|480p?|bluray|webrip|web|dl|streaming|en streaming|film complet|complet|gratuit|regarder|voir)\b/g;
const YEAR_IN_TITLE = /\b(19|20)\d{2}\b/;

/** Titre d'un résultat sans année ni mentions de langue/qualité ; renvoie aussi l'année trouvée dans le titre. */
// « Saison 2 », « Season 3 », « S2 », « Partie 1 » (séries) : le titre de la série suffit pour la correspondance.
const SEASON_NOISE = /\b(saison|season|s)\s*\d{1,2}\b|\b(partie|part|cour)\s*\d\b|\b\d{1,2}(e|eme|ème|nd|rd|th)?\s*saison\b/gi;

function cleanResultTitle(raw) {
  const text = String(raw || '').replace(SEASON_NOISE, ' ');
  const year = (text.match(YEAR_IN_TITLE) || [null])[0];
  const cleaned = normalizeTitle(text.replace(/\((?:19|20)\d{2}\)|\[(?:19|20)\d{2}\]/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' '))
    .replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  return { cleaned, year };
}

/**
 * Similarité entre un titre TMDB et le titre d'un résultat (0..1).
 * Ignore année, langue et qualité ajoutées par le site ; tolère un ou deux mots en plus.
 */
function similarity(tmdbTitle, resultTitle) {
  const a = normalizeTitle(tmdbTitle);
  const b = cleanResultTitle(resultTitle).cleaned;
  if (!a || !b) return 0;
  let score = Math.max(dice(a.replace(/ /g, ''), b.replace(/ /g, '')), dice(a.replace(/ /g, ''), normalizeTitle(resultTitle).replace(/ /g, '')));
  // Tous les mots du titre présents, avec un mot en plus (deux si le titre en a plusieurs) : correspond.
  const ta = a.split(' ');
  const tb = new Set(b.split(' '));
  const extra = tb.size - new Set(ta).size;
  if (ta.every((w) => tb.has(w)) && extra <= (ta.length > 1 ? 2 : 1)) score = Math.max(score, ta.length > 1 ? 0.92 : 0.86);
  return Math.min(1, score);
}

const LATIN = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u;

/** Titres à comparer : titre, titre original (s'il est en alphabet latin), titres alternatifs TMDB. */
function titlesOf(media) {
  const all = [media.title, media.originalTitle, ...(media.altTitles || [])].filter((t) => t && LATIN.test(t));
  return [...new Set(all)];
}

/**
 * Meilleur résultat pour un média TMDB, ou null.
 * Films : l'année doit correspondre (± tolérance). Séries : l'année ne sert qu'à départager,
 * car les sites affichent souvent l'année de la saison et non celle de la première diffusion.
 */
function pickBest(results, media, match) {
  const titles = titlesOf(media);
  if (!titles.length) titles.push(media.title);
  let best = null;
  for (const r of results) {
    let score = Math.max(...titles.map((t) => similarity(t, r.title)));
    const ry = r.year || cleanResultTitle(r.title).year;
    if (media.year && ry) {
      const diff = Math.abs(Number(media.year) - Number(ry));
      if (diff === 0) score += 0.05; // départage les remakes
      else if (diff > match.yearTolerance) {
        if (media.type !== 'tv') continue;
        score -= 0.04;
      }
    }
    if (score >= match.minScore && (!best || score > best.score)) best = { ...r, score };
  }
  return best;
}

/**
 * Diagnostic : pourquoi un média correspond (ou non) aux résultats d'une source.
 * Renvoie { status: 'ok'|'year'|'title'|'empty', best: { title, year, link, score, yearDiff } }.
 */
function explainMatch(results, media, match) {
  if (!results.length) return { status: 'empty', best: null };
  const ok = pickBest(results, media, match);
  if (ok) return { status: 'ok', best: { title: ok.title, year: ok.year || cleanResultTitle(ok.title).year, link: ok.link, score: ok.score } };
  const titles = titlesOf(media);
  if (!titles.length) titles.push(media.title);
  let top = null;
  for (const r of results) {
    const score = Math.max(...titles.map((t) => similarity(t, r.title)));
    if (!top || score > top.score) top = { ...r, score };
  }
  const ry = top.year || cleanResultTitle(top.title).year;
  const yearDiff = media.year && ry ? Math.abs(Number(media.year) - Number(ry)) : null;
  const status = top.score >= match.minScore ? 'year' : 'title';
  return { status, best: { title: top.title, year: ry || null, link: top.link, score: top.score, yearDiff } };
}

// ------------------------------------------------------------ Réseau

async function fetchHtml(url, headers = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_UA, Accept: 'text/html,application/xhtml+xml', ...headers },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${new URL(url).host}`);
    return { html: await res.text(), url: res.url || url };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Délai dépassé sur ${new URL(url).host}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Premier nombre trouvé (« Saison 2 » → 2). */
function firstInt(v) {
  const m = String(v || '').match(/\d+/);
  return m ? Number(m[0]) : NaN;
}

// ------------------------------------------------------------ Rendu JavaScript (fourni par le processus Electron)

let pageRenderer = null;
/** fn(url, { headers }) → { html, url } : page rendue dans un navigateur invisible. */
function setPageRenderer(fn) { pageRenderer = fn; }
function canRender() { return !!pageRenderer; }

/** HTML brut, ou page rendue (JavaScript exécuté) si la source le demande. */
// Pages récentes (recherches, liste d'épisodes) : évite de recharger — et surtout de re-rendre — la même page.
const pageCache = new Map();
const PAGE_TTL = 3 * 60 * 1000;

async function fetchPage(url, headers = {}, render = false) {
  const key = `${render ? 'R' : 'S'}|${url}|${JSON.stringify(headers || {})}`;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.at < PAGE_TTL) return hit.promise;
  let promise;
  if (!render) promise = fetchHtml(url, headers);
  else if (!pageRenderer) throw new Error('Rendu JavaScript indisponible');
  else promise = pageRenderer(url, { headers });
  pageCache.set(key, { at: Date.now(), promise });
  promise.catch(() => pageCache.delete(key)); // une erreur n'est pas mise en cache
  if (pageCache.size > 60) pageCache.delete(pageCache.keys().next().value);
  return promise;
}

function clearPageCache() { pageCache.clear(); }

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// ------------------------------------------------------------ Pipeline par source

/** Résultats bruts de la page de recherche d'une source pour une requête. */
async function searchQuery(provider, query) {
  const s = provider.search;
  const url = fill(s.url, { baseUrl: provider.baseUrl.replace(/\/$/, ''), query: encodeURIComponent(query) });
  const { html, url: finalUrl } = await fetchPage(url, provider.headers, provider.render);
  const $ = cheerio.load(html);
  return $(s.item).toArray().map((el) => ({
    title: extract($, el, s.title, finalUrl),
    link: extract($, el, s.link, finalUrl),
    year: extract($, el, s.year, finalUrl),
  })).filter((r) => r.title && r.link);
}

/**
 * Recherche le média sur la source et renvoie la meilleure page correspondante.
 * Requêtes essayées dans l'ordre : titre, titre original (alphabet latin), titres alternatifs TMDB
 * (ex. nom romaji d'un anime). S'arrête dès qu'un résultat correspond.
 */
async function search(provider, media, { maxQueries = 3, skipQueries = [] } = {}) {
  const template = provider.search.query || '{title}';
  const queryFor = (title) => fill(template, {
    title,
    originalTitle: media.originalTitle || media.title,
    year: media.year || '',
    type: media.type,
  }).replace(/\s+/g, ' ').trim();
  const skip = new Set(skipQueries.map((q) => normalizeTitle(q)));
  const queries = [...new Set(titlesOf(media).map(queryFor))].filter((q) => !skip.has(normalizeTitle(q))).slice(0, maxQueries);
  if (!queries.length && !skip.size) queries.push(queryFor(media.title));

  const all = [];
  for (const query of queries) {
    for (const r of await searchQuery(provider, query)) if (!all.some((x) => x.link === r.link)) all.push(r);
    const best = pickBest(all, media, provider.match);
    if (best) return { results: all, best, query };
  }
  return { results: all, best: null };
}

/** Pour une série, renvoie l'URL de la page de l'épisode. */
async function episodeUrl(provider, showUrl, season, episode) {
  const ep = provider.episodes;
  const pad = (n) => String(n).padStart(2, '0');
  const vars = { link: showUrl.replace(/\/$/, ''), season, episode, season2: pad(season), episode2: pad(episode) };
  if (ep.urlTemplate || ep.params) {
    const base = ep.urlTemplate ? fill(ep.urlTemplate, vars) : showUrl;
    if (!ep.params) return base;
    // Saison / épisode passés en paramètres d'adresse : ?s={season}&ep={episode}
    const u = new URL(base);
    for (const [k, v] of Object.entries(ep.params)) u.searchParams.set(k, fill(v, vars));
    return u.toString();
  }
  // Liste d'épisodes lue sur la page de la série (adresses non prévisibles, ex. /episode/48213).
  // pageTemplate / pageParams : page à charger pour une saison donnée (ex. ?season={season}).
  let listUrl = ep.pageTemplate ? fill(ep.pageTemplate, vars) : showUrl;
  if (ep.pageParams) {
    const u = new URL(listUrl);
    for (const [k, v] of Object.entries(ep.pageParams)) u.searchParams.set(k, fill(v, vars));
    listUrl = u.toString();
  }
  const { html, url } = await fetchPage(listUrl, provider.headers, provider.render);
  const $ = cheerio.load(html);
  for (const el of $(ep.item).toArray()) {
    const eNum = firstInt(extract($, el, ep.episode, url));
    // Sans sélecteur de saison, la page ne montre qu'une saison (celle demandée via pageParams/pageTemplate).
    const seasonOk = ep.season ? firstInt(extract($, el, ep.season, url)) === Number(season) : true;
    if (seasonOk && eNum === Number(episode)) {
      const link = extract($, el, ep.link, url);
      if (link) return link;
    }
  }
  throw new Error(`Épisode S${pad(season)}E${pad(episode)} introuvable`);
}

/** Si la source définit player.iframe, renvoie l'URL de l'iframe du lecteur (sinon la page elle-même). */
async function playerPage(provider, pageUrl) {
  const sel = provider.player && provider.player.iframe;
  if (!sel) return { url: pageUrl, referer: null };
  const { html, url } = await fetchPage(pageUrl, provider.headers, provider.render);
  const $ = cheerio.load(html);
  const src = extract($, $.root(), sel, url);
  if (!src) return { url: pageUrl, referer: null }; // iframe injectée en JS : on laisse le navigateur faire
  return { url: src.startsWith('//') ? `https:${src}` : src, referer: url };
}

module.exports = {
  extract, normalizeTitle, similarity, cleanResultTitle, pickBest, explainMatch, titlesOf, fill, search, searchQuery, episodeUrl, playerPage,
  fetchHtml, fetchPage, clearPageCache, setPageRenderer, canRender, DEFAULT_UA,
};
