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
function similarity(a, b) {
  const x = normalizeTitle(a).replace(/ /g, '');
  const y = normalizeTitle(b).replace(/ /g, '');
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

/** Choisit le meilleur résultat pour un média TMDB, ou null. */
function pickBest(results, media, match) {
  const titles = [media.title, media.originalTitle].filter(Boolean);
  let best = null;
  for (const r of results) {
    let score = Math.max(...titles.map((t) => similarity(t, r.title)));
    if (media.year && r.year) {
      const diff = Math.abs(Number(media.year) - Number(r.year));
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

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// ------------------------------------------------------------ Pipeline par source

/** Recherche le média sur la source et renvoie la meilleure page correspondante. */
async function search(provider, media) {
  const s = provider.search;
  const query = fill(s.query || '{title}', {
    title: media.title,
    originalTitle: media.originalTitle || media.title,
    year: media.year || '',
    type: media.type,
  }).trim();
  const url = fill(s.url, { baseUrl: provider.baseUrl.replace(/\/$/, ''), query: encodeURIComponent(query) });
  const { html, url: finalUrl } = await fetchHtml(url, provider.headers);
  const $ = cheerio.load(html);
  const results = $(s.item).toArray().map((el) => ({
    title: extract($, el, s.title, finalUrl),
    link: extract($, el, s.link, finalUrl),
    year: extract($, el, s.year, finalUrl),
  })).filter((r) => r.title && r.link);
  return { results, best: pickBest(results, media, provider.match) };
}

/** Pour une série, renvoie l'URL de la page de l'épisode. */
async function episodeUrl(provider, showUrl, season, episode) {
  const ep = provider.episodes;
  const pad = (n) => String(n).padStart(2, '0');
  if (ep.urlTemplate) {
    return fill(ep.urlTemplate, {
      link: showUrl.replace(/\/$/, ''), season, episode, season2: pad(season), episode2: pad(episode),
    });
  }
  const { html, url } = await fetchHtml(showUrl, provider.headers);
  const $ = cheerio.load(html);
  for (const el of $(ep.item).toArray()) {
    const sNum = parseInt(extract($, el, ep.season, url), 10);
    const eNum = parseInt(extract($, el, ep.episode, url), 10);
    if (sNum === Number(season) && eNum === Number(episode)) {
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
  const { html, url } = await fetchHtml(pageUrl, provider.headers);
  const $ = cheerio.load(html);
  const src = extract($, $.root(), sel, url);
  if (!src) return { url: pageUrl, referer: null }; // iframe injectée en JS : on laisse le navigateur faire
  return { url: src.startsWith('//') ? `https:${src}` : src, referer: url };
}

module.exports = { extract, normalizeTitle, similarity, pickBest, fill, search, episodeUrl, playerPage, fetchHtml, DEFAULT_UA };
