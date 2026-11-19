'use strict';
/**
 * Préchargement des flux : la résolution (recherche sur les sources + interception du flux) démarre
 * dès l'ouverture d'une fiche ; « Lire » réutilise le résultat, ou attend la résolution déjà en cours.
 *
 * - Une résolution par média (clé type:tmdbId:saison:épisode), partagée entre préchargement et lecture.
 * - « Emplacements » (page, survol…) : ouvrir une autre fiche annule le préchargement précédent
 *   s'il n'est pas attendu par le lecteur.
 * - Les flux trouvés expirent (jetons limités dans le temps) : 8 min par défaut.
 */
const { resolveMedia: defaultResolve } = require('./pipeline');

const keyOf = (m) => `${m.type}:${m.tmdbId}:${m.season || 0}:${m.episode || 0}`;

function publicStatus(e) {
  return {
    key: e.key,
    status: e.status,
    provider: e.result ? e.result.provider.name : null,
    error: e.error ? e.error.message : null,
    code: e.error ? e.error.code || null : null,
  };
}

class StreamCache {
  constructor(repo, { emit = () => {}, ttlMs = 8 * 60 * 1000, failTtlMs = 60 * 1000, resolve = defaultResolve, matches = null } = {}) {
    this.repo = repo;
    this.matches = matches;
    this.emit = emit;
    this.ttl = ttlMs;
    this.failTtl = failTtlMs;
    this.resolveImpl = resolve;
    this.entries = new Map();
    this.slots = new Map();
  }

  status(media) {
    const e = this.entries.get(keyOf(media));
    return e && this.#usable(e) ? publicStatus(e) : { key: keyOf(media), status: 'idle' };
  }

  /** Démarre (ou réutilise) la résolution en arrière-plan. */
  prefetch(media, slot = 'page') {
    const key = keyOf(media);
    const prev = this.slots.get(slot);
    if (prev && prev !== key) {
      const pe = this.entries.get(prev);
      if (pe && pe.status === 'resolving' && pe.wanted === 0 && ![...this.slots.entries()].some(([s, k]) => s !== slot && k === prev)) this.#cancel(pe);
    }
    this.slots.set(slot, key);
    // Ouverture d'une fiche : les préparations en survol d'autres titres n'ont plus d'intérêt.
    if (slot === 'page') {
      for (const [other, k] of [...this.slots.entries()]) {
        if (other === 'page' || k === key) continue;
        const oe = this.entries.get(k);
        if (oe && oe.status === 'resolving' && oe.wanted === 0) this.#cancel(oe);
        this.slots.delete(other);
      }
    }
    let e = this.entries.get(key);
    if (!e || !this.#usable(e)) e = this.#start(media);
    return publicStatus(e);
  }

  /** Pour la lecture : résultat en cache, résolution en cours, ou nouvelle résolution. */
  async resolve(media, { fresh = false } = {}) {
    const key = keyOf(media);
    let e = this.entries.get(key);
    if (fresh || !e || !this.#usable(e) || e.status === 'failed') e = this.#start(media);
    else if (e.status === 'resolving') for (const p of e.progress) this.emit('player:progress', { key, ...p });
    const wasReady = e.status === 'ready';
    e.wanted++;
    try {
      const r = await e.promise;
      return { ...r, cached: wasReady };
    } finally {
      e.wanted--;
    }
  }

  /** Les sources ont changé : tout est à refaire. */
  clear() {
    for (const e of [...this.entries.values()]) if (e.status === 'resolving' && e.wanted === 0) this.#cancel(e);
    this.entries.clear();
  }

  #usable(e) {
    if (e.status === 'resolving') return true;
    if (e.status === 'ready') return Date.now() - e.doneAt < this.ttl;
    if (e.status === 'failed') return Date.now() - e.doneAt < this.failTtl;
    return false;
  }

  #start(media) {
    const key = keyOf(media);
    const old = this.entries.get(key);
    if (old && old.status === 'resolving' && old.wanted === 0) this.#cancel(old);
    const ctrl = new AbortController();
    const e = { key, media, status: 'resolving', ctrl, wanted: 0, progress: [], result: null, error: null, doneAt: 0 };
    e.promise = this.resolveImpl(this.repo, media, {
      signal: ctrl.signal,
      matches: this.matches,
      onProgress: (p) => {
        e.progress.push(p);
        this.emit('player:progress', { key, ...p });
      },
    }).then(
      (r) => {
        e.status = 'ready';
        e.result = r;
        e.doneAt = Date.now();
        this.#announce(e);
        return r;
      },
      (err) => {
        e.status = ctrl.signal.aborted ? 'cancelled' : 'failed';
        e.error = err;
        e.doneAt = Date.now();
        if (e.status === 'cancelled' && this.entries.get(key) === e) this.entries.delete(key);
        this.#announce(e);
        throw err;
      },
    );
    e.promise.catch(() => {});
    this.entries.set(key, e);
    this.#announce(e);
    return e;
  }

  #cancel(e) {
    e.ctrl.abort();
    e.status = 'cancelled';
    if (this.entries.get(e.key) === e) this.entries.delete(e.key);
    this.#announce(e);
  }

  #announce(e) {
    this.emit('stream:status', publicStatus(e));
  }
}

module.exports = { StreamCache, keyOf };
