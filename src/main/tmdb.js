'use strict';
/** Client TMDB minimal avec cache mémoire. Accepte une clé API v3 ou un jeton de lecture v4. */
const API = 'https://api.themoviedb.org/3';
const TTL = 10 * 60 * 1000;

class Tmdb {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.cache = new Map();
  }

  async get(path, params = {}) {
    const { tmdbKey, language } = this.getSettings();
    if (!tmdbKey) {
      const err = new Error('Clé TMDB manquante. Ajoutez-la dans Réglages.');
      err.code = 'NO_KEY';
      throw err;
    }
    if (!/^\/[a-z0-9/_-]+$/i.test(path)) throw new Error('Chemin TMDB invalide');
    const url = new URL(API + path);
    const isBearer = tmdbKey.length > 40;
    if (!isBearer) url.searchParams.set('api_key', tmdbKey);
    url.searchParams.set('language', language || 'fr-FR');
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));

    const key = url.toString() + (isBearer ? '#b' : '');
    const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.data;

    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...(isBearer ? { Authorization: `Bearer ${tmdbKey}` } : {}) },
    });
    if (res.status === 401) {
      const err = new Error('Clé TMDB refusée. Vérifiez-la dans Réglages.');
      err.code = 'BAD_KEY';
      throw err;
    }
    if (!res.ok) throw new Error(`TMDB : HTTP ${res.status}`);
    const data = await res.json();
    this.cache.set(key, { data, exp: Date.now() + TTL });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    return data;
  }

  clear() { this.cache.clear(); }
}

module.exports = { Tmdb };
