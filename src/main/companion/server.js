'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { SourceValidationError } = require('../sources/validator');
const builder = require('../sources/builder');

const MAX_BODY = 1024 * 1024;
const MAX_FAILURES = 10;
const PAGE = path.join(__dirname, '..', '..', 'companion', 'index.html');

/**
 * Serveur compagnon du réseau local : page web + API JSON (protégée par code à 6 chiffres).
 * Même API que la version Fire TV : la page compagnon est identique.
 */
class CompanionServer {
  constructor(repo) {
    this.repo = repo;
    this.server = null;
    this.code = null;
    this.failures = 0;
    this.lockedUntil = 0;
  }

  get running() { return !!this.server; }

  async start(ports = [8080, 8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089, 8090]) {
    if (this.server) return this.info();
    this.code = String(crypto.randomInt(100000, 1000000));
    for (const port of ports) {
      const srv = http.createServer((req, res) => this.#handle(req, res));
      const ok = await new Promise((resolve) => {
        srv.once('error', () => resolve(false));
        srv.listen(port, '0.0.0.0', () => resolve(true));
      });
      if (ok) { this.server = srv; this.port = port; return this.info(); }
    }
    throw new Error('Aucun port libre entre 8080 et 8090');
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
  }

  async info() {
    const ip = localIpv4();
    if (!ip) return { running: true, ip: null, port: this.port, code: this.code, url: null, qr: null };
    const url = `http://${ip}:${this.port}`;
    const qr = await QRCode.toDataURL(`${url}/?code=${this.code}`, { margin: 1, width: 560, errorCorrectionLevel: 'M' });
    return { running: true, ip, port: this.port, code: this.code, url, qr };
  }

  // ------------------------------------------------------------ Routage

  async #handle(req, res) {
    try {
      const url = new URL(req.url, 'http://local');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const m = req.method;

      if (m === 'GET' && (p === '/' || p === '/index.html')) {
        return send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
      }
      if (!p.startsWith('/api/')) throw httpError(404, 'Introuvable');
      this.#authorize(req);

      const seg = p.slice(5).split('/').map(decodeURIComponent);
      const r = this.repo;
      const is = (method, ...parts) => m === method && seg.length === parts.length && parts.every((x, i) => x === '*' || x === seg[i]);

      if (is('GET', 'state')) return this.#state(res);
      if (is('GET', 'export')) return send(res, 200, r.exportLocal(), 'application/json; charset=utf-8');
      if (is('POST', 'sync')) { await r.syncAll(); return this.#state(res); }
      if (is('POST', 'subscriptions')) { await r.addSubscription((await body(req)).url); return this.#state(res); }
      if (is('POST', 'subscriptions', '*', 'sync')) { await r.sync(seg[1]); return this.#state(res); }
      if (is('POST', 'subscriptions', '*', 'toggle')) { await r.setSubscriptionEnabled(seg[1], (await body(req)).enabled); return this.#state(res); }
      if (is('DELETE', 'subscriptions', '*')) { await r.removeSubscription(seg[1]); return this.#state(res); }
      if (is('POST', 'providers')) { await r.upsertLocalProvider(await body(req)); return this.#state(res); }
      if (is('POST', 'providers', '*', 'toggle')) { await r.setProviderEnabled(seg[1], (await body(req)).enabled); return this.#state(res); }
      if (is('DELETE', 'providers', '*')) { await r.removeLocalProvider(seg[1]); return this.#state(res); }
      if (is('POST', 'import')) { await r.importDocument(await rawBody(req)); return this.#state(res); }

      // Assistant de création de source
      if (is('GET', 'builder')) return sendJson(res, 200, { version: 1 });
      if (is('POST', 'builder', 'analyze')) {
        const b = await body(req);
        return sendJson(res, 200, await builder.analyzeUrl(b.url, b.headers || {}, { render: !!b.render }));
      }
      if (is('POST', 'builder', 'episodes')) {
        const b = await body(req);
        return sendJson(res, 200, await builder.analyzeEpisodes(b));
      }
      if (is('POST', 'builder', 'test')) {
        const b = await body(req);
        return sendJson(res, 200, await builder.testProvider(b.provider, b));
      }

      throw httpError(404, `Route inconnue : ${m} ${p}`);
    } catch (err) {
      const status = err.status || 400;
      const details = err instanceof SourceValidationError ? err.errors : [];
      sendJson(res, status, { error: err.message || 'Erreur', details });
    }
  }

  #authorize(req) {
    const now = Date.now();
    if (now < this.lockedUntil) throw httpError(429, 'Trop de tentatives, réessayez dans une minute');
    const given = Buffer.from(String(req.headers['x-pairing-code'] || ''));
    const expected = Buffer.from(this.code);
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) {
      if (++this.failures >= MAX_FAILURES) { this.lockedUntil = now + 60000; this.failures = 0; }
      throw httpError(401, 'Code d\'appairage incorrect');
    }
    this.failures = 0;
  }

  #state(res) {
    sendJson(res, 200, this.repo.publicState());
  }
}

// ------------------------------------------------------------ Helpers

function localIpv4() {
  const ifaces = os.networkInterfaces();
  const list = Object.entries(ifaces).flatMap(([name, addrs]) => (addrs || []).map((a) => ({ name, ...a })))
    .filter((a) => a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  const score = (n) => (/wi-?fi|wlan|wireless/i.test(n) ? 0 : /ethernet|eth|en\d/i.test(n) ? 1 : /vethernet|virtual|vmware|vbox|docker|wsl/i.test(n) ? 9 : 2);
  list.sort((a, b) => score(a.name) - score(b.name));
  return list[0] ? list[0].address : null;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function rawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(httpError(413, 'Corps trop volumineux')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function body(req) {
  const raw = await rawBody(req);
  try { return raw ? JSON.parse(raw) : {}; } catch { throw httpError(400, 'JSON invalide'); }
}

function send(res, status, data, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(data);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

module.exports = { CompanionServer, localIpv4 };
