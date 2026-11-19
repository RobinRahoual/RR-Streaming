'use strict';
const { BrowserWindow, session } = require('electron');
const { createClassifier } = require('./classifier');
const { DEFAULT_UA } = require('../sources/scraper');

let counter = 0;

/**
 * Rend une page dans une fenêtre invisible (JavaScript exécuté) et renvoie son HTML final.
 * Utilisé par l'assistant et par les sources marquées `render: true`.
 * Images, polices, médias et publicités sont bloqués ; les redirections vers un autre site aussi.
 * Attend que le contenu se stabilise (nombre de liens constant) avant de lire le DOM.
 */
async function renderHtml(url, { headers = {}, timeoutMs = 20000, userAgent = DEFAULT_UA } = {}) {
  const ses = session.fromPartition(`render-${process.pid}-${++counter}`, { cache: false });
  ses.setUserAgent(userAgent);
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  const classifier = createClassifier({});
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (d, cb) => {
    cb({ cancel: d.resourceType === 'media' || classifier.shouldBlock(d.url, d.resourceType) });
  });

  const win = new BrowserWindow({
    show: false,
    width: 1366,
    height: 2000,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, images: false, backgroundThrottling: false, spellcheck: false },
  });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  let pageHost = null;
  try { pageHost = new URL(url).hostname; } catch { /* vérifié plus bas */ }
  const guard = (e, target, isMainFrame = true) => {
    if (isMainFrame && !classifier.isNavigationAllowed(target, pageHost)) e.preventDefault();
  };
  wc.on('will-navigate', (e, target) => guard(e, target));
  wc.on('will-redirect', (e, target, _inPlace, isMainFrame) => guard(e, target, isMainFrame));
  wc.on('will-prevent-unload', (e) => e.preventDefault());

  const deadline = Date.now() + timeoutMs;
  try {
    const extraHeaders = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n') || undefined;
    await Promise.race([
      wc.loadURL(url, { userAgent, extraHeaders }).catch((err) => {
        if (!/ERR_ABORTED/.test(String(err && err.message))) throw new Error(`Chargement impossible : ${err.message}`);
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Délai dépassé au chargement de la page')), timeoutMs)),
    ]);

    // Attendre que les résultats injectés en JavaScript soient en place.
    let last = -1;
    let stable = 0;
    while (Date.now() < deadline && stable < 3) {
      await new Promise((r) => setTimeout(r, 500));
      if (wc.isDestroyed()) break;
      const n = await wc.executeJavaScript('document.querySelectorAll("a[href]").length').catch(() => -1);
      stable = n === last && n > 0 ? stable + 1 : 0;
      last = n;
    }
    if (wc.isDestroyed()) throw new Error('La page s\'est fermée');
    const html = await wc.executeJavaScript('document.documentElement.outerHTML');
    return { html, url: wc.getURL() || url };
  } finally {
    ses.webRequest.onBeforeRequest(null);
    if (!win.isDestroyed()) win.destroy();
    ses.clearStorageData().catch(() => {});
  }
}

module.exports = { renderHtml };
