'use strict';
const cheerio = require('cheerio');

const SUPPORTED_SCHEMA = 1;
const ID = /^[a-z0-9][a-z0-9_-]{1,47}$/;
const probe = cheerio.load('<html></html>');

function isHttpUrl(v) {
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

/** Applique les valeurs par défaut du schéma à une source. */
function normalizeProvider(p) {
  return {
    enabled: true,
    priority: 50,
    types: ['movie', 'tv'],
    headers: {},
    match: { minScore: 0.8, yearTolerance: 1 },
    player: {},
    ...p,
    search: { query: '{title}', ...(p.search || {}) },
    match: { minScore: 0.8, yearTolerance: 1, ...(p.match || {}) },
    player: { allowedHosts: [], ...(p.player || {}) },
  };
}

function validateDocument(doc) {
  const e = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['Le document doit être un objet JSON'];
  if (!Number.isInteger(doc.schemaVersion) || doc.schemaVersion < 1 || doc.schemaVersion > SUPPORTED_SCHEMA) {
    e.push(`schemaVersion ${doc.schemaVersion} non supportée (max ${SUPPORTED_SCHEMA})`);
  }
  if (!Array.isArray(doc.providers) || doc.providers.length === 0) {
    e.push('providers : la liste est vide');
    return e;
  }
  const seen = new Set();
  doc.providers.forEach((p, i) => {
    if (p && seen.has(p.id)) e.push(`providers : id en double « ${p.id} »`);
    if (p) seen.add(p.id);
    e.push(...validateProvider(p, `providers[${i}]`));
  });
  return e;
}

function validateProvider(raw, path = 'provider') {
  const e = [];
  if (!raw || typeof raw !== 'object') return [`${path} : doit être un objet`];
  const p = normalizeProvider(raw);

  if (typeof p.id !== 'string' || !ID.test(p.id)) e.push(`${path}.id : « ${p.id} » invalide (a-z, 0-9, - et _ ; 2 à 48 caractères)`);
  if (typeof p.name !== 'string' || !p.name.trim()) e.push(`${path}.name : requis`);
  if (!Number.isInteger(p.priority) || p.priority < 0 || p.priority > 100) e.push(`${path}.priority : entier entre 0 et 100`);
  if (!isHttpUrl(p.baseUrl)) e.push(`${path}.baseUrl : URL http(s) invalide`);
  if (!Array.isArray(p.types) || !p.types.length || p.types.some((t) => t !== 'movie' && t !== 'tv')) {
    e.push(`${path}.types : valeurs autorisées "movie" et "tv"`);
  }
  if (p.render != null && typeof p.render !== 'boolean') e.push(`${path}.render : true ou false`);
  if (p.headers && (typeof p.headers !== 'object' || Object.values(p.headers).some((v) => typeof v !== 'string'))) {
    e.push(`${path}.headers : objet de chaînes attendu`);
  }

  const s = raw.search;
  if (!s || typeof s !== 'object') {
    e.push(`${path}.search : requis`);
  } else {
    if (typeof s.url !== 'string' || !s.url.includes('{query}')) e.push(`${path}.search.url : doit contenir {query}`);
    else if (!isHttpUrl(s.url.replace('{baseUrl}', p.baseUrl).replace('{query}', 'x'))) e.push(`${path}.search.url : URL invalide après substitution`);
    css(e, s.item, `${path}.search.item`);
    selector(e, s.title, `${path}.search.title`, true);
    selector(e, s.link, `${path}.search.link`, true);
    selector(e, s.year, `${path}.search.year`, false);
    selector(e, s.poster, `${path}.search.poster`, false);
  }

  if (typeof p.match.minScore !== 'number' || p.match.minScore < 0 || p.match.minScore > 1) e.push(`${path}.match.minScore : entre 0 et 1`);

  if (Array.isArray(p.types) && p.types.includes('tv')) {
    const ep = raw.episodes;
    if (!ep) e.push(`${path}.episodes : requis pour les séries (types contient "tv")`);
    else if (ep.urlTemplate != null || ep.params != null) {
      if (ep.urlTemplate != null && typeof ep.urlTemplate !== 'string') e.push(`${path}.episodes.urlTemplate : chaîne attendue`);
      const params = ep.params || {};
      if (typeof params !== 'object' || Array.isArray(params) || Object.values(params).some((v) => typeof v !== 'string')) {
        e.push(`${path}.episodes.params : objet de chaînes attendu`);
      } else {
        // {season} et {episode} peuvent être dans l'adresse ou dans les paramètres
        const all = [ep.urlTemplate || '', ...Object.values(params)].join(' ');
        if (!/\{season2?\}/.test(all) || !/\{episode2?\}/.test(all)) {
          e.push(`${path}.episodes : {season} et {episode} doivent apparaître dans urlTemplate ou params`);
        }
      }
    } else if (!ep.item || !ep.episode || !ep.link) {
      e.push(`${path}.episodes : urlTemplate, params ou (item + episode + link) requis`);
    } else {
      css(e, ep.item, `${path}.episodes.item`);
      selector(e, ep.season, `${path}.episodes.season`, false);
      selector(e, ep.episode, `${path}.episodes.episode`, true);
      selector(e, ep.link, `${path}.episodes.link`, true);
      if (ep.pageTemplate != null && (typeof ep.pageTemplate !== 'string' || !/\{season2?\}/.test(ep.pageTemplate))) {
        e.push(`${path}.episodes.pageTemplate : doit contenir {season}`);
      }
      if (ep.pageParams != null && (typeof ep.pageParams !== 'object' || Array.isArray(ep.pageParams) || Object.values(ep.pageParams).some((v) => typeof v !== 'string'))) {
        e.push(`${path}.episodes.pageParams : objet de chaînes attendu`);
      }
    }
  }

  selector(e, p.player.iframe, `${path}.player.iframe`, false);
  if (p.player.extraHlsPattern != null) regex(e, p.player.extraHlsPattern, `${path}.player.extraHlsPattern`);
  if (p.player.timeoutMs != null && (!Number.isInteger(p.player.timeoutMs) || p.player.timeoutMs < 3000 || p.player.timeoutMs > 60000)) {
    e.push(`${path}.player.timeoutMs : entre 3000 et 60000`);
  }
  if (p.player.allowedHosts && !Array.isArray(p.player.allowedHosts)) e.push(`${path}.player.allowedHosts : tableau attendu`);
  return e;
}

function selector(e, s, path, required) {
  if (s == null) { if (required) e.push(`${path} : requis`); return; }
  if (typeof s !== 'object' || typeof s.css !== 'string') { e.push(`${path} : objet { css, attr?, regex? } attendu`); return; }
  if (s.css.trim()) css(e, s.css, `${path}.css`);
  if (s.attr != null && (typeof s.attr !== 'string' || !s.attr.trim())) e.push(`${path}.attr : chaîne non vide attendue`);
  if (s.regex != null) regex(e, s.regex, `${path}.regex`);
}

function css(e, q, path) {
  if (typeof q !== 'string' || !q.trim()) { e.push(`${path} : sélecteur vide`); return; }
  try { probe(q); } catch (err) { e.push(`${path} : sélecteur CSS invalide (${err.message})`); }
}

function regex(e, r, path) {
  try { new RegExp(r); } catch (err) { e.push(`${path} : regex invalide (${err.message})`); }
}

class SourceValidationError extends Error {
  constructor(errors) {
    super(`Fichier de sources invalide (${errors.length} erreur(s))`);
    this.errors = errors;
  }
}

module.exports = { validateDocument, validateProvider, normalizeProvider, SourceValidationError, SUPPORTED_SCHEMA };
