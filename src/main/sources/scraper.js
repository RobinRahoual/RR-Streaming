'use strict';
const cheerio = require('cheerio');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ------------------------------------------------------------ Extraction

/** Applique un sélecteur { css, attr, regex } à un élément cheerio. */
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
function cleanResultTitle(raw) {
  const text = String(raw || '');
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

/** Meilleur résultat pour un média TMDB, ou null. */
function pickBest(results, media, match) {
  const titles = [media.title, media.originalTitle].filter(Boolean);
  let best = null;
  for (const r of results) {
    let score = Math.max(...titles.map((t) => similarity(t, r.title)));
    const ry = r.year || cleanResultTitle(r.title).year;
    if (media.year && ry) {
      const diff = Math.abs(Number(media.year) - Number(ry));
      if (diff > match.yearTolerance) continue;
      if (diff === 0) score += 0.05; // départage les remakes
    }
    if (score >= match.minScore && (!best || score > best.score)) best = { ...r, score };
  }
  return best;
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
async function fetchPage(url, headers = {}, render = false) {
  if (!render) return fetchHtml(url, headers);
  if (!pageRenderer) throw new Error('Rendu JavaScript indisponible');
  return pageRenderer(url, { headers });
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// ------------------------------------------------------------ Pipeline par source

/**
 * Recherche le média sur la source et renvoie la meilleure page correspondante.
 * Essaie le titre, puis le titre original s'il diffère (beaucoup de sites indexent les films sous leur titre original).
 */
async function search(provider, media) {
  const s = provider.search;
  const template = s.query || '{title}';
  const queryFor = (title) => fill(template, {
    title,
    originalTitle: media.originalTitle || media.title,
    year: media.year || '',
    type: media.type,
  }).replace(/\s+/g, ' ').trim();
  const queries = [...new Set([queryFor(media.title), media.originalTitle ? queryFor(media.originalTitle) : null].filter(Boolean))];

  const all = [];
  for (const query of queries) {
    const url = fill(s.url, { baseUrl: provider.baseUrl.replace(/\/$/, ''), query: encodeURIComponent(query) });
    const { html, url: finalUrl } = await fetchPage(url, provider.headers, provider.render);
    const $ = cheerio.load(html);
    const results = $(s.item).toArray().map((el) => ({
      title: extract($, el, s.title, finalUrl),
      link: extract($, el, s.link, finalUrl),
      year: extract($, el, s.year, finalUrl),
    })).filter((r) => r.title && r.link);
    for (const r of results) if (!all.some((x) => x.link === r.link)) all.push(r);
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
  extract, normalizeTitle, similarity, cleanResultTitle, pickBest, fill, search, episodeUrl, playerPage,
  fetchHtml, fetchPage, setPageRenderer, canRender, DEFAULT_UA,
};
