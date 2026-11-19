'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { validateDocument, validateProvider, normalizeProvider, SourceValidationError } = require('./validator');

const MAX_BYTES = 1024 * 1024;

const emptyStore = () => ({ version: 1, revision: 0, subscriptions: [], localProviders: [], disabledIds: [] });

/**
 * Source de vérité des sources : listes distantes (JSON), sources locales, persistance, synchronisation.
 * Émet 'change' (store) à chaque modification.
 */
class SourceRepository extends EventEmitter {
  constructor(dir, { fetchImpl = fetch } = {}) {
    super();
    this.file = path.join(dir, 'sources_store.json');
    this.fetch = fetchImpl;
    this.store = emptyStore();
    this.queue = Promise.resolve();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) this.store = { ...emptyStore(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch (err) {
      console.error('[sources] store illisible, réinitialisation', err);
      this.store = emptyStore();
    }
    return this.store;
  }

  // ------------------------------------------------------------ Lecture

  /** Toutes les sources à plat, avec origine et état effectif, triées par priorité. */
  entries() {
    const disabled = new Set(this.store.disabledIds);
    const byId = new Map();
    for (const sub of this.store.subscriptions) {
      for (const raw of sub.providers) {
        const p = normalizeProvider(raw);
        byId.set(p.id, { provider: p, subscriptionId: sub.id, originName: sub.name, enabled: sub.enabled && p.enabled && !disabled.has(p.id) });
      }
    }
    for (const raw of this.store.localProviders) {
      const p = normalizeProvider(raw);
      byId.set(p.id, { provider: p, subscriptionId: null, originName: 'Local', enabled: p.enabled && !disabled.has(p.id) });
    }
    return [...byId.values()].sort((a, b) => b.provider.priority - a.provider.priority);
  }

  /** Sources à essayer, dans l'ordre, pour un type de média. */
  activeProviders(kind) {
    return this.entries().filter((e) => e.enabled && (!kind || e.provider.types.includes(kind))).map((e) => e.provider);
  }

  publicState() {
    return {
      revision: this.store.revision,
      subscriptions: this.store.subscriptions.map(({ providers, etag, ...s }) => ({ ...s, providerCount: providers.length })),
      providers: this.entries(),
    };
  }

  // ------------------------------------------------------------ Listes distantes

  async addSubscription(rawUrl) {
    const url = normalizeUrl(rawUrl);
    if (!url) throw new Error('URL invalide');
    if (this.store.subscriptions.some((s) => s.url === url)) throw new Error('Cette liste est déjà ajoutée');
    const res = await this.#fetch(url, null);
    const sub = {
      id: crypto.randomUUID(),
      url,
      name: (res.doc.name || '').trim() || new URL(url).host,
      enabled: true,
      lastSyncAt: Date.now(),
      etag: res.etag,
      lastError: null,
      providers: res.doc.providers,
    };
    await this.#update((s) => ({ ...s, subscriptions: [...s.subscriptions, sub] }));
    return sub;
  }

  async sync(id) {
    const sub = this.store.subscriptions.find((s) => s.id === id);
    if (!sub) throw new Error('Liste introuvable');
    try {
      const res = await this.#fetch(sub.url, sub.etag);
      await this.#updateSub(id, (s) => res.notModified
        ? { ...s, lastSyncAt: Date.now(), lastError: null }
        : { ...s, name: (res.doc.name || '').trim() || s.name, providers: res.doc.providers, etag: res.etag, lastSyncAt: Date.now(), lastError: null });
    } catch (err) {
      // Une liste cassée garde ses anciennes sources.
      await this.#updateSub(id, (s) => ({ ...s, lastError: userMessage(err) }));
      throw err;
    }
  }

  async syncAll() {
    const results = await Promise.allSettled(this.store.subscriptions.filter((s) => s.enabled).map((s) => this.sync(s.id)));
    return { ok: results.filter((r) => r.status === 'fulfilled').length, failed: results.filter((r) => r.status === 'rejected').length };
  }

  async syncIfStale(maxAgeMs = 24 * 3600 * 1000) {
    const now = Date.now();
    for (const s of this.store.subscriptions) {
      if (s.enabled && (s.lastSyncAt || 0) < now - maxAgeMs) await this.sync(s.id).catch(() => {});
    }
  }

  removeSubscription(id) {
    return this.#update((s) => ({ ...s, subscriptions: s.subscriptions.filter((x) => x.id !== id) }));
  }

  setSubscriptionEnabled(id, enabled) {
    return this.#updateSub(id, (s) => ({ ...s, enabled: !!enabled }));
  }

  // ------------------------------------------------------------ Sources locales

  async upsertLocalProvider(provider) {
    const errors = validateProvider(provider);
    if (errors.length) throw new SourceValidationError(errors);
    await this.#update((s) => ({
      ...s,
      localProviders: [...s.localProviders.filter((p) => p.id !== provider.id), provider],
      disabledIds: s.disabledIds.filter((id) => id !== provider.id),
    }));
  }

  removeLocalProvider(id) {
    return this.#update((s) => ({ ...s, localProviders: s.localProviders.filter((p) => p.id !== id) }));
  }

  setProviderEnabled(id, enabled) {
    return this.#update((s) => ({
      ...s,
      disabledIds: enabled ? s.disabledIds.filter((x) => x !== id) : [...new Set([...s.disabledIds, id])],
    }));
  }

  async importDocument(raw) {
    const doc = parseAndValidate(raw);
    const ids = new Set(doc.providers.map((p) => p.id));
    await this.#update((s) => ({
      ...s,
      localProviders: [...s.localProviders.filter((p) => !ids.has(p.id)), ...doc.providers],
      disabledIds: s.disabledIds.filter((id) => !ids.has(id)),
    }));
    return doc.providers.length;
  }

  exportLocal() {
    return JSON.stringify({ schemaVersion: 1, name: 'Sources locales', providers: this.store.localProviders }, null, 2);
  }

  // ------------------------------------------------------------ Interne

  async #fetch(url, etag) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await this.fetch(url, {
        headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) },
        signal: ctrl.signal,
      });
      if (res.status === 304) return { notModified: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_BYTES) throw new Error('Fichier trop volumineux (> 1 Mo)');
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('Fichier trop volumineux (> 1 Mo)');
      return { doc: parseAndValidate(text), etag: res.headers.get('etag') };
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Délai dépassé');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  #updateSub(id, fn) {
    return this.#update((s) => ({ ...s, subscriptions: s.subscriptions.map((x) => (x.id === id ? fn(x) : x)) }));
  }

  /** Écritures sérialisées + sauvegarde atomique (fichier temporaire puis renommage). */
  #update(fn) {
    const run = this.queue.then(() => {
      const next = { ...fn(this.store) };
      next.revision = (this.store.revision || 0) + 1;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next));
      fs.renameSync(tmp, this.file);
      this.store = next;
      this.emit('change', this.store);
      return next;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

function parseAndValidate(raw) {
  let doc;
  try {
    doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    throw new SourceValidationError([`JSON invalide : ${err.message}`]);
  }
  const errors = validateDocument(doc);
  if (errors.length) throw new SourceValidationError(errors);
  return doc;
}

function normalizeUrl(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  try {
    const u = new URL(t.includes('://') ? t : `http://${t}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function userMessage(err) {
  if (err instanceof SourceValidationError) return err.errors.slice(0, 3).join(' · ');
  return err.message || String(err);
}

module.exports = { SourceRepository, normalizeUrl };
