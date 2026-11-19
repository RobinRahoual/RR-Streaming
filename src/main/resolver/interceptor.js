'use strict';
const { BrowserWindow, session } = require('electron');
const { createClassifier, rank } = require('./classifier');
const { DEFAULT_UA } = require('../sources/scraper');

const AUTOPLAY_JS = `(() => { try {
  document.querySelectorAll('video,audio').forEach(v => { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); });
  ['.vjs-big-play-button','.jw-icon-display','.plyr__control--overlaid','[aria-label="Play"]','.play-button','#play','button.play']
    .forEach(s => { const b = document.querySelector(s); if (b) b.click(); });
} catch (e) {} })();`;

let counter = 0;

/**
 * Charge une page dans une fenêtre invisible, écoute le réseau, capture les manifests vidéo
 * (.m3u8 / .mpd / .mp4) avec leurs headers, bloque pubs / ressources inutiles / redirections.
 *
 * @returns {Promise<{best, all}>}
 */
async function resolveStream(pageUrl, opts = {}) {
  const {
    referer = null,
    headers = {},
    timeoutMs = 20000,
    settleMs = 1500,
    allowedHosts = [],
    extraHlsPattern = null,
    userAgent = DEFAULT_UA,
    onLog = () => {},
  } = opts;

  const classifier = createClassifier({ allowedHosts, extraHlsPattern });
  // Session éphémère dédiée : cookies isolés, aucun impact sur le reste de l'app.
  const ses = session.fromPartition(`resolver-${process.pid}-${++counter}`, { cache: false });
  ses.setUserAgent(userAgent);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const candidates = new Map();
  let order = 0;
  let pageHost = safeHost(pageUrl);
  let firstHitResolve, failReject;
  const firstHit = new Promise((res, rej) => { firstHitResolve = res; failReject = rej; });

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      images: false,
      webgl: false,
      spellcheck: false,
    },
  });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 1) Blocage précoce (pubs, images, polices, CSS)
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (d, cb) => {
    cb({ cancel: !classifier.detectStream(d.url) && classifier.shouldBlock(d.url, d.resourceType) });
  });

  // 2) Détection des manifests : ici on a les headers réellement envoyés
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (d, cb) => {
    const type = classifier.detectStream(d.url);
    if (!type) return cb({ requestHeaders: d.requestHeaders });
    if (!candidates.has(d.url)) {
      captureHeaders(ses, d).then((h) => {
        candidates.set(d.url, { url: d.url, type, headers: h, sourcePage: wc.isDestroyed() ? pageUrl : wc.getURL(), order: order++ });
        onLog(`Flux détecté (${type.toUpperCase()}) : ${d.url.slice(0, 120)}`);
        firstHitResolve();
      });
    }
    // Le manifest n'est pas téléchargé par la fenêtre : pas de son, pas de bande passante, token préservé.
    cb({ cancel: true });
  });

  // 3) Redirections / navigations hors site
  const guard = (e, url, isMainFrame = true) => {
    if (isMainFrame && !classifier.isNavigationAllowed(url, pageHost)) {
      e.preventDefault();
      onLog(`Navigation bloquée → ${url.slice(0, 100)}`);
    }
  };
  wc.on('will-navigate', (e, url) => guard(e, url));
  wc.on('will-redirect', (e, url, _inPlace, isMainFrame) => guard(e, url, isMainFrame));
  wc.on('did-navigate', (_e, url) => { pageHost = safeHost(url) || pageHost; });
  wc.on('will-prevent-unload', (e) => e.preventDefault());
  wc.on('render-process-gone', () => failReject(new Error('Le moteur de rendu s\'est arrêté')));
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) failReject(new Error(`Chargement impossible : ${desc}`)); // -3 = ERR_ABORTED (souvent volontaire)
  });

  // 4) Lancer la lecture, y compris dans les iframes cross-origin
  let autoplayTimer = null;
  const autoplay = (n = 0) => {
    if (wc.isDestroyed() || candidates.size || n >= 4) return;
    try {
      for (const f of wc.mainFrame.framesInSubtree) f.executeJavaScript(AUTOPLAY_JS).catch(() => {});
    } catch { /* frame détruite */ }
    autoplayTimer = setTimeout(() => autoplay(n + 1), 1200);
  };
  wc.on('did-finish-load', () => autoplay());

  try {
    const extraHeaders = Object.entries({ ...headers, ...(referer ? { Referer: referer } : {}) })
      .map(([k, v]) => `${k}: ${v}`).join('\n');
    wc.loadURL(pageUrl, { userAgent, extraHeaders: extraHeaders || undefined, httpReferrer: referer || undefined }).catch(() => {});

    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Aucun flux vidéo détecté (délai dépassé)')), timeoutMs));
    await Promise.race([firstHit, timeout]);
    await new Promise((r) => setTimeout(r, settleMs)); // master + variantes
    const all = rank(candidates.values());
    return { best: all[0], all };
  } finally {
    clearTimeout(autoplayTimer);
    ses.webRequest.onBeforeRequest(null);
    ses.webRequest.onBeforeSendHeaders(null);
    if (!win.isDestroyed()) win.destroy();
    ses.clearStorageData().catch(() => {});
  }
}

async function captureHeaders(ses, d) {
  const h = {};
  const get = (k) => {
    const key = Object.keys(d.requestHeaders).find((x) => x.toLowerCase() === k.toLowerCase());
    return key ? d.requestHeaders[key] : null;
  };
  h['User-Agent'] = get('User-Agent') || ses.getUserAgent();
  if (get('Referer')) h.Referer = get('Referer');
  else if (d.referrer) h.Referer = d.referrer;
  if (get('Origin')) h.Origin = get('Origin');
  let cookie = get('Cookie');
  if (!cookie) {
    try {
      const cookies = await ses.cookies.get({ url: d.url });
      if (cookies.length) cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch { /* ignore */ }
  }
  if (cookie) h.Cookie = cookie;
  return h;
}

function safeHost(u) {
  try { return new URL(u).hostname; } catch { return null; }
}

module.exports = { resolveStream };
