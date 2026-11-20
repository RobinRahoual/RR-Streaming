'use strict';
const { BrowserWindow, session } = require('electron');
const { createClassifier, rank } = require('./classifier');
const { DEFAULT_UA } = require('../sources/scraper');

const AUTOPLAY_JS = `(() => { try {
  document.querySelectorAll('video,audio').forEach(v => { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); });
  ['.vjs-big-play-button','.jw-icon-display','.plyr__control--overlaid','[aria-label="Play"]','.play-button','#play','button.play']
    .forEach(s => { const b = document.querySelector(s); if (b) b.click(); });
} catch (e) {} })();`;

// Centre du lecteur dans la page : plus grande vidéo / iframe / zone « player » visible,
// ramenée dans la fenêtre. Un lecteur sous un grand en-tête n'est pas au centre de l'écran.
const TARGET_JS = `(() => { try {
  const els = [...document.querySelectorAll('video,iframe,embed,object,[id*="player" i],[class*="player" i]')];
  let best = null, area = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 120) continue;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0) continue;
    if (r.width * r.height > area) { area = r.width * r.height; best = el; }
  }
  if (!best) return null;
  best.scrollIntoView({ block: 'center', inline: 'center' });
  const r = best.getBoundingClientRect();
  const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 2);
  const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 2);
  return [Math.round(x), Math.round(y)];
} catch (e) { return null; } })()`;

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
    timeoutMs = 30000,
    settleMs = 1500,
    allowedHosts = [],
    extraHlsPattern = null,
    userAgent = DEFAULT_UA,
    onLog = () => {},
    signal = null,
  } = opts;
  if (signal && signal.aborted) throw new Error('Annulé');

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

  // Clics : déclarés ici car les gardes de navigation relancent un clic après une pub bloquée.
  let clickTimer = null;
  let clicks = 0;
  let lastClickAt = 0;
  const userTriggered = () => Date.now() - lastClickAt < 3000;
  let scheduleClick = () => {};

  // Pop-ups : refuser window.open fait croire à certains scripts qu'un bloqueur est actif, et ils
  // gardent leur surcouche sur le lecteur. La pop-up est donc « acceptée » dans une fenêtre
  // invisible qui ne charge rien (requêtes annulées plus bas) et est détruite aussitôt.
  const popups = new Set();
  wc.setWindowOpenHandler(({ url }) => {
    onLog(`Pop-up publicitaire neutralisée → ${String(url).slice(0, 100)}`);
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        show: false, width: 200, height: 200,
        webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, images: false, spellcheck: false },
      },
    };
  });
  wc.on('did-create-window', (child) => {
    popups.add(child);
    try {
      child.webContents.setAudioMuted(true);
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    } catch { /* déjà fermée */ }
    setTimeout(() => { if (!child.isDestroyed()) child.destroy(); popups.delete(child); }, 1500);
    scheduleClick(800);
  });

  // 1) Blocage précoce (pubs, images, polices, CSS) ; rien n'est chargé par une pop-up.
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (d, cb) => {
    if (d.webContentsId !== undefined && d.webContentsId !== wc.id) return cb({ cancel: true });
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

  // 3) Redirections / navigations hors site, page principale ET iframes (le lecteur est souvent
  // dans une iframe : une pub qui détourne le clic y remplace le lecteur par sa page).
  const blocked = (url) => {
    onLog(`Redirection publicitaire bloquée → ${String(url).slice(0, 100)}`);
    scheduleClick(800); // le clic a été consommé par la pub : recliquer vite
  };
  const guard = (e, url, isMainFrame = true) => {
    if (isMainFrame && !classifier.isNavigationAllowed(url, pageHost)) {
      e.preventDefault();
      blocked(url);
    }
  };
  const frameGuard = (details) => {
    if (!details || details.isMainFrame) return;
    let frameUrl = '';
    try { frameUrl = details.frame ? details.frame.url : ''; } catch { /* frame détruite */ }
    if (!classifier.isFrameNavigationAllowed(details.url, frameUrl, { userTriggered: userTriggered() })) {
      details.preventDefault();
      blocked(details.url);
    }
  };
  wc.on('will-navigate', (e, url) => guard(e, url));
  wc.on('will-frame-navigate', frameGuard);
  wc.on('will-redirect', (e, url, _inPlace, isMainFrame) => {
    if (isMainFrame) guard(e, url, true);
    else frameGuard(e);
  });
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
  wc.on('did-finish-load', () => { onLog(`Page chargée : ${safeHost(wc.getURL())}`); autoplay(); });
  // Iframes chargées (hébergeur du lecteur) : utile au diagnostic.
  const seenFrames = new Set();
  wc.on('did-frame-navigate', (_e, url, code, _status, isMainFrame) => {
    const h = safeHost(url);
    if (isMainFrame || !h || seenFrames.has(h) || seenFrames.size > 8) return;
    seenFrames.add(h);
    onLog(`Iframe : ${h}${code >= 400 ? ` (HTTP ${code})` : ''}`);
  });
  // Vrais clics souris sur le lecteur (geste « utilisateur ») : beaucoup de lecteurs ne démarrent
  // qu'ainsi, et le premier clic est souvent détourné par une pub (pop-up ou redirection, bloquées
  // plus haut) : on reclique alors rapidement, jusqu'à 10 fois.
  const click = async () => {
    clickTimer = null;
    if (wc.isDestroyed() || candidates.size || clicks >= 10) return;
    clicks++;
    let target = null;
    try { target = await wc.executeJavaScript(TARGET_JS); } catch { /* page en cours de changement */ }
    if (wc.isDestroyed() || candidates.size) return;
    const [x, y] = Array.isArray(target) ? target : [640, 360];
    lastClickAt = Date.now();
    onLog(`Clic ${clicks} sur le lecteur (${x}, ${y})`);
    await trustedClick(wc, x, y);
    try { for (const f of wc.mainFrame.framesInSubtree) f.executeJavaScript(AUTOPLAY_JS).catch(() => {}); } catch { /* ignore */ }
    if (!clickTimer) clickTimer = setTimeout(click, 2500);
  };
  scheduleClick = (delay) => {
    if (wc.isDestroyed() || candidates.size || clicks >= 10) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(click, delay);
  };
  wc.once('did-finish-load', () => scheduleClick(2000));
  const onAbort = () => failReject(new Error('Annulé'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

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
    if (signal) signal.removeEventListener('abort', onAbort);
    clearTimeout(autoplayTimer);
    clearTimeout(clickTimer);
    ses.webRequest.onBeforeRequest(null);
    ses.webRequest.onBeforeSendHeaders(null);
    try { if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* ignore */ }
    for (const p of popups) if (!p.isDestroyed()) p.destroy();
    if (!win.isDestroyed()) win.destroy();
    ses.clearStorageData().catch(() => {});
  }
}

/**
 * Clic souris « réel » (isTrusted, geste utilisateur) au point (x, y), iframes comprises.
 * wc.sendInputEvent n'atteint pas la page d'une fenêtre invisible : on passe par le protocole
 * DevTools (Input.dispatchMouseEvent), qui fonctionne fenêtre cachée.
 */
async function trustedClick(wc, x, y) {
  if (wc.isDestroyed()) return false;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    const send = (type, extra = {}) => wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, ...extra });
    await send('mouseMoved');
    await send('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
    await send('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
    return true;
  } catch {
    try { // DevTools indisponible (déjà ouvert, fenêtre fermée) : ancienne méthode
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      return true;
    } catch { return false; }
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
