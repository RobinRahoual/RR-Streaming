'use strict';
/**
 * Assistant de création de source : analyse automatique d'une page pour proposer des sélecteurs
 * sans que l'utilisateur écrive de CSS.
 *  - analyzeHtml : détecte les listes de résultats répétées (carte + lien + titre + affiche + année)
 *    et les iframes de lecteur ;
 *  - testProvider : lance une vraie recherche avec une source en cours de création.
 * Le port Kotlin (BuilderAnalyzer.kt) suit le même algorithme.
 */
const cheerio = require('cheerio');
const scraper = require('./scraper');
const { extract, search } = scraper;
const { validateProvider, normalizeProvider, SourceValidationError } = require('./validator');

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'path', 'head', 'meta', 'link', 'template', 'option', 'select', 'form', 'input', 'button']);
const NAV_ANCESTORS = 'header, nav, footer, aside, [role=navigation], .menu, .navbar, .nav, .pagination, .breadcrumb, .footer, .header';
const YEAR_REGEX = '(?:^|\\D)((?:19|20)\\d{2})(?:\\D|$)';
const YEAR = new RegExp(YEAR_REGEX);
const YEAR_ALONE = /^\D{0,12}(19|20)\d{2}\D{0,12}$/;
const IMG_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-srcset', 'src'];
const MAX_CANDIDATES = 3;

function cssEscape(s) {
  return String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}

function goodClasses(el) {
  return String((el.attribs && el.attribs.class) || '')
    .split(/\s+/)
    .filter((c) => /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(c) && c.length < 40 && !/\d{3,}/.test(c) && !/^(active|selected|current|hover|show|open|is-|js-|swiper-slide-)/.test(c))
    .slice(0, 2);
}

/** "tag.classe1.classe2" (ou "tag" sans classe exploitable). */
function signature(el) {
  return el.tagName + goodClasses(el).map((c) => `.${cssEscape(c)}`).join('');
}

function absolute(url, base) {
  try {
    const u = new URL(url, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function imgAttr($img) {
  for (const a of IMG_ATTRS) {
    const v = $img.attr(a);
    if (v && !v.startsWith('data:')) return a;
  }
  return null;
}

// ------------------------------------------------------------ Analyse d'un élément « résultat »

function inspectItem($, el, pageUrl) {
  const $el = $(el);
  const anchors = el.tagName === 'a' ? $el : $el.find('a[href]');
  if (!anchors.length) return null;

  // Lien principal : celui qui contient un titre ou une image, sinon le premier.
  let anchor = anchors.filter((_, a) => $(a).find('h1,h2,h3,h4,h5,h6,img,[class*=title]').length > 0).first();
  if (!anchor.length) anchor = anchors.first();
  const link = absolute(anchor.attr('href'), pageUrl);
  if (!link || link.split('#')[0] === pageUrl.split('#')[0]) return null;

  // Titre
  let title = null;
  let titleSel = null;
  const heading = $el.find('h1,h2,h3,h4,h5,h6').first();
  const titled = heading.length ? heading : $el.find('[class*=title]').first();
  if (titled.length && titled.text().trim()) {
    title = titled.text();
    titleSel = { css: signature(titled[0]), attr: 'text' };
  } else if (anchor.attr('title')) {
    title = anchor.attr('title');
    titleSel = { css: el.tagName === 'a' ? '' : 'a', attr: 'title' };
  } else if ($el.find('img[alt]').first().attr('alt')) {
    title = $el.find('img[alt]').first().attr('alt');
    titleSel = { css: 'img', attr: 'alt' };
  } else if (anchor.text().trim()) {
    title = anchor.text();
    titleSel = { css: el.tagName === 'a' ? '' : 'a', attr: 'text' };
  }
  title = title ? title.replace(/\s+/g, ' ').trim() : null;
  if (!title || title.length < 2 || title.length > 150) return null;

  // Lien relatif à l'élément
  let linkSel;
  if (el.tagName === 'a') linkSel = { css: '', attr: 'href' };
  else if (anchor[0] === anchors.first()[0]) linkSel = { css: 'a', attr: 'href' };
  else if (goodClasses(anchor[0]).length) linkSel = { css: signature(anchor[0]), attr: 'href' };
  else linkSel = { css: 'a:has(h1,h2,h3,h4,h5,h6,img)', attr: 'href' };

  // Affiche
  const img = $el.find('img').first();
  const attr = img.length ? imgAttr(img) : null;
  const posterSel = attr ? { css: 'img', attr } : null;

  // Année : de préférence un élément qui ne contient que l'année
  let yearSel = null;
  const own = $el.find('*').filter((_, n) => {
    const t = $(n).clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
    return YEAR_ALONE.test(t);
  }).first();
  if (own.length && goodClasses(own[0]).length) yearSel = { css: signature(own[0]), attr: 'text', regex: YEAR_REGEX };
  else if (YEAR.test($el.text())) yearSel = { css: '', attr: 'text', regex: YEAR_REGEX };

  return { titleSel, linkSel, posterSel, yearSel, fromHeading: !!titled.length, hasImg: !!attr };
}

// ------------------------------------------------------------ Détection des listes de résultats

function findResultCandidates($, pageUrl) {
  const groups = new Map();
  $('body *').each((_, el) => {
    if (el.type !== 'tag' || SKIP_TAGS.has(el.tagName) || !el.parent || el.parent.type !== 'tag') return;
    if (el.tagName !== 'a' && !$(el).find('a[href]').length) return;
    const key = `${signature(el.parent)} > ${signature(el)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(el);
  });

  const candidates = [];
  for (const [key, members] of groups) {
    if (members.length < 2 || members.length > 300) continue;
    const sample = members.slice(0, 40);
    const infos = sample.map((m) => inspectItem($, m, pageUrl));
    const valid = infos.filter(Boolean);
    if (valid.length / sample.length < 0.6) continue;
    const proto = valid[0];

    // Sélecteur de l'élément : signature seule si elle est assez précise, sinon avec le parent.
    const own = signature(members[0]);
    const itemSel = goodClasses(members[0]).length && $(own).length <= members.length * 1.5 ? own : key;
    const item = {
      item: itemSel,
      title: proto.titleSel,
      link: proto.linkSel,
      ...(valid.filter((v) => v.hasImg).length / valid.length >= 0.5 && proto.posterSel ? { poster: proto.posterSel } : {}),
      ...(valid.filter((v) => v.yearSel).length / valid.length >= 0.5 && proto.yearSel ? { year: proto.yearSel } : {}),
    };

    // Vérification avec le vrai moteur d'extraction (garantit le même résultat à l'usage).
    const results = $(item.item).toArray().map((el) => ({
      title: extract($, el, item.title, pageUrl),
      link: extract($, el, item.link, pageUrl),
      year: item.year ? extract($, el, item.year, pageUrl) : null,
      poster: item.poster ? absolute(extract($, el, { ...item.poster, regex: null }, pageUrl), pageUrl) : null,
    })).filter((r) => r.title && r.link);
    if (results.length < 2) continue;

    const uniqueLinks = new Set(results.map((r) => r.link)).size / results.length;
    const avgTitle = results.reduce((s, r) => s + r.title.length, 0) / results.length;
    // Les résultats ne sont jamais dans l'en-tête, le menu ou le pied de page.
    if ($(members[0]).closest(NAV_ANCESTORS).length > 0) continue;
    const score =
      Math.min(results.length, 30) *
      uniqueLinks *
      (item.poster ? 1.6 : 1) *
      (proto.fromHeading ? 1.3 : 1) *
      (item.year ? 1.15 : 1) *
      (goodClasses(members[0]).length ? 1.1 : 1) *
      (/^(article|li)$/.test(members[0].tagName) || /card|item|movie|film|serie|show|result|post|entry|poster/i.test(goodClasses(members[0]).join(' ')) ? 1.25 : 1) *
      (/(^|\s)(col|row|grid|container|wrapper)/i.test(goodClasses(members[0]).join(' ')) ? 0.85 : 1) *
      (avgTitle < 4 ? 0.3 : 1);

    candidates.push({ selectors: item, count: results.length, samples: results.slice(0, 5), score, linkKey: results.slice(0, 5).map((r) => r.link).join('|') });
  }

  // Une même liste détectée à deux niveaux (div.col > article.card) : on garde la meilleure.
  candidates.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const top = candidates.length ? candidates[0].score : 0;
  return candidates
    .filter((c) => c.score >= top * 0.2)
    .filter((c) => (seen.has(c.linkKey) ? false : seen.add(c.linkKey)))
    .slice(0, MAX_CANDIDATES)
    .map(({ selectors, count, samples }) => ({ selectors, count, samples }));
}

// ------------------------------------------------------------ Iframes de lecteur

function findIframes($, pageUrl) {
  const pageHost = new URL(pageUrl).hostname;
  const out = [];
  $('iframe').each((_, el) => {
    const $el = $(el);
    const attr = $el.attr('src') && !/^about:|^javascript:/.test($el.attr('src')) ? 'src' : $el.attr('data-src') ? 'data-src' : null;
    if (!attr) return;
    const src = absolute($el.attr(attr).startsWith('//') ? `https:${$el.attr(attr)}` : $el.attr(attr), pageUrl);
    if (!src) return;
    const host = new URL(src).hostname;
    let css;
    if (el.attribs.id) css = /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(el.attribs.id) ? `iframe#${el.attribs.id}` : `iframe[id="${el.attribs.id.replace(/"/g, '')}"]`;
    else if (goodClasses(el).length) css = signature(el);
    else css = `iframe[${attr}*="${host.replace(/"/g, '')}"]`;
    const trailer = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|dailymotion\.com)$/i.test(host);
    const likely = !trailer && (/embed|player|video|stream|watch/i.test(src) || host !== pageHost);
    const ad = /doubleclick|googlesyndication|ads?\.|facebook|twitter|disqus|recaptcha/i.test(host);
    if (!ad) out.push({ selector: { css, attr }, src, host, likely, trailer });
  });
  return out.sort((a, b) => Number(b.likely) - Number(a.likely)).slice(0, 6);
}

// ------------------------------------------------------------ API

function analyzeHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  return {
    url: pageUrl,
    pageTitle: $('title').first().text().trim() || null,
    candidates: findResultCandidates($, pageUrl),
    iframes: findIframes($, pageUrl),
  };
}

/**
 * Analyse une page. Si le HTML brut ne donne rien (site construit en JavaScript, ou visite
 * automatique refusée), la page est rendue dans un navigateur invisible puis réanalysée.
 * `rendered: true` dans la réponse indique que la source devra utiliser ce rendu (provider.render).
 */
async function analyzeUrl(url, headers = {}, { render = false } = {}) {
  const u = absolute(String(url || '').trim().includes('://') ? url : `https://${url}`, 'https://x');
  if (!u) throw new Error('Adresse invalide');

  if (!render) {
    let staticResult = null;
    let staticError = null;
    try {
      const { html, url: finalUrl } = await scraper.fetchHtml(u, headers);
      staticResult = analyzeHtml(html, finalUrl);
    } catch (err) {
      staticError = err;
    }
    const useful = staticResult && (staticResult.candidates.length || staticResult.iframes.length);
    if (useful || !scraper.canRender()) {
      if (staticResult) return { ...staticResult, rendered: false };
      throw staticError;
    }
  }
  const { html, url: finalUrl } = await scraper.fetchPage(u, headers, true);
  return { ...analyzeHtml(html, finalUrl), rendered: true };
}


// ------------------------------------------------------------ Liste d'épisodes (adresses non prévisibles)

function sameUrl(a, b) {
  const norm = (u) => {
    try {
      const x = new URL(u);
      x.hash = '';
      return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`.toLowerCase();
    } catch { return String(u).toLowerCase(); }
  };
  return norm(a) === norm(b);
}

/** Expression régulière qui extrait le k-ième nombre d'un texte (0 = premier). */
function nthNumberRegex(k) {
  return k === 0 ? '(\\d+)' : `^(?:\\D*\\d+){${k}}\\D*?(\\d+)`;
}

/**
 * Cherche dans l'élément le texte qui contient `value` et renvoie un sélecteur { css, attr, regex }
 * qui l'extrait. `avoid` : { node, index } déjà utilisé (pour ne pas confondre saison et épisode).
 */
function numberSelector($, item, value, avoid = null) {
  const nodes = [item, ...$(item).find('*').toArray()];
  const options = [];
  for (const n of nodes) {
    if (SKIP_TAGS.has(n.tagName)) continue;
    const text = $(n).text().replace(/\s+/g, ' ').trim();
    if (!text || (n !== item && text.length > 80)) continue;
    const nums = text.match(/\d+/g) || [];
    nums.forEach((x, k) => {
      if (Number(x) !== Number(value)) return;
      if (avoid && avoid.text === text && avoid.index === k) return;
      let css = '';
      if (n !== item) {
        css = signature(n);
        if ($(item).find(css).first()[0] !== n) css = n.tagName;
        if ($(item).find(css).first()[0] !== n) return;
      }
      options.push({ selector: { css, attr: 'text', regex: nthNumberRegex(k) }, text, index: k, len: text.length, classed: n !== item && goodClasses(n).length > 0 });
    });
  }
  // Attributs (data-episode="6"…)
  for (const n of nodes) {
    for (const [name, v] of Object.entries(n.attribs || {})) {
      if (/^data-/.test(name) && String(v).trim() === String(value) && !(avoid && avoid.attr === name)) {
        const css = n === item ? '' : signature(n);
        if (n === item || $(item).find(css).first()[0] === n) options.push({ selector: { css, attr: name }, attr: name, len: 0, classed: true });
      }
    }
  }
  options.sort((a, b) => Number(b.classed) - Number(a.classed) || a.len - b.len);
  return options[0] || null;
}

function seasonParamsFrom(showUrl, season) {
  try {
    const u = new URL(showUrl);
    for (const [k, v] of u.searchParams) {
      if (/^(s|sa|saison|season|sea|ss)$/i.test(k) && /^\d+$/.test(v) && Number(v) === Number(season)) return { [k]: '{season}' };
    }
  } catch { /* adresse déjà vérifiée */ }
  return null;
}

/**
 * Assistant, étape « séries » quand l'adresse d'un épisode n'est pas déductible de celle de la série
 * (ex. /episode/48213) : repère l'épisode d'exemple sur la page de la série, en déduit la liste
 * d'épisodes et les sélecteurs (élément, numéro d'épisode, lien, saison si nécessaire).
 */
function analyzeEpisodesHtml(html, pageUrl, { showUrl, episodeUrl, season, episode }) {
  const $ = cheerio.load(html);
  const anchor = $('a[href]').toArray().find((a) => {
    const abs = absolute($(a).attr('href'), pageUrl);
    return abs && sameUrl(abs, episodeUrl);
  });
  if (!anchor) {
    const err = new Error("L'épisode d'exemple n'apparaît pas sur la page de la série. Vérifiez les deux adresses, ou ouvrez la page de la série qui liste ses épisodes.");
    err.code = 'EPISODE_NOT_FOUND';
    throw err;
  }

  // Élément répété qui contient le lien de l'épisode.
  let item = null;
  let siblings = [];
  for (let n = anchor; n && n.type === 'tag' && n.tagName !== 'body'; n = n.parent) {
    if (!n.parent || n.parent.type !== 'tag') break;
    const sig = signature(n);
    siblings = $(n.parent).children().toArray().filter((c) => signature(c) === sig && (c.tagName === 'a' || $(c).find('a[href]').length));
    if (siblings.length >= 2) { item = n; break; }
  }
  if (!item) throw new Error("La page de la série ne présente pas de liste d'épisodes reconnaissable. Utilisez le mode avancé (JSON).");

  const own = signature(item);
  const key = `${signature(item.parent)} > ${own}`;
  const itemSel = goodClasses(item).length && $(own).length <= $(key).length * 1.5 ? own : key;
  const firstA = item.tagName === 'a' ? item : $(item).find('a[href]').first()[0];
  const link = item.tagName === 'a' ? { css: '', attr: 'href' }
    : firstA === anchor ? { css: 'a', attr: 'href' }
    : { css: goodClasses(anchor).length ? signature(anchor) : 'a', attr: 'href' };

  const epOpt = numberSelector($, item, episode);
  if (!epOpt) throw new Error(`Le numéro ${episode} n'apparaît pas dans l'épisode d'exemple sur la page de la série. Vérifiez le numéro de l'épisode.`);
  const spec = { item: itemSel, episode: epOpt.selector, link };

  const rows = $(itemSel).toArray().map((el) => ({
    episode: Number((extract($, el, spec.episode, pageUrl) || '').match(/\d+/)?.[0]),
    link: extract($, el, spec.link, pageUrl),
    el,
  })).filter((r) => r.link && Number.isFinite(r.episode));
  if (!rows.some((r) => sameUrl(r.link, episodeUrl))) throw new Error("La liste détectée ne permet pas de retrouver l'épisode d'exemple. Utilisez le mode avancé (JSON).");

  let warning = null;
  const sameNumber = rows.filter((r) => r.episode === Number(episode)).length;
  if (sameNumber > 1) {
    // Plusieurs saisons sur la même page : il faut lire la saison dans chaque élément.
    const seOpt = numberSelector($, item, season, epOpt.attr ? { attr: epOpt.attr } : { text: epOpt.text, index: epOpt.index });
    if (!seOpt) throw new Error(`La page liste plusieurs saisons mais le numéro de saison ${season} n'apparaît pas dans l'épisode d'exemple. Utilisez le mode avancé (JSON).`);
    spec.season = seOpt.selector;
  } else {
    const params = seasonParamsFrom(showUrl, season);
    if (params) spec.pageParams = params;
    else if (Number(season) !== 1) warning = `La page de la série semble n'afficher qu'une saison. RR Streaming trouvera les épisodes affichés par défaut sur cette page.`;
    else warning = "Pour les autres saisons, RR Streaming utilisera les épisodes affichés sur la page de la série. Si le site a une page par saison, refaites ce test avec un épisode de la saison 2.";
  }

  const samples = rows.slice(0, 8).map((r) => ({
    episode: r.episode,
    season: spec.season ? Number((extract($, r.el, spec.season, pageUrl) || '').match(/\d+/)?.[0]) || null : null,
    link: r.link,
  }));
  return { spec, count: rows.length, samples, warning };
}

async function analyzeEpisodes({ showUrl, episodeUrl, season, episode, headers = {}, render = false }) {
  if (!absolute(showUrl, 'https://x') || !absolute(episodeUrl, 'https://x')) throw new Error('Adresse invalide');
  const args = { showUrl, episodeUrl, season: Number(season), episode: Number(episode) };
  if (!render) {
    try {
      const { html, url } = await scraper.fetchHtml(showUrl, headers);
      return { ...analyzeEpisodesHtml(html, url, args), rendered: false };
    } catch (err) {
      if (!scraper.canRender()) throw err;
    }
  }
  const { html, url } = await scraper.fetchPage(showUrl, headers, true);
  return { ...analyzeEpisodesHtml(html, url, args), rendered: true };
}

/** Recherche réelle avec une source en cours de création. */
async function testProvider(draft, { title, year, type = 'movie' }) {
  const errors = validateProvider(draft);
  if (errors.length) throw new SourceValidationError(errors);
  if (!title || !String(title).trim()) throw new Error('Indiquez un titre à rechercher');
  const provider = normalizeProvider(draft);
  const { results, best } = await search(provider, { type, title: String(title).trim(), originalTitle: String(title).trim(), year: year ? String(year) : '' });
  return { results: results.slice(0, 8), best };
}

module.exports = { analyzeHtml, analyzeUrl, testProvider, analyzeEpisodes, analyzeEpisodesHtml };
