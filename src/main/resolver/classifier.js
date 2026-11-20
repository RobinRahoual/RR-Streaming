'use strict';
/** Logique pure (sans Electron) : détection de manifests, blocage, classement. Testée unitairement. */

const DEFAULT_BLOCKED = [
  /(^|\.)doubleclick\.net$/, /(^|\.)googlesyndication\.com$/, /(^|\.)google-analytics\.com$/,
  /(^|\.)googletagmanager\.com$/, /(^|\.)adservice\.google\./, /(^|\.)popads\.net$/, /(^|\.)popcash\.net$/,
  /(^|\.)propellerads\.com$/, /(^|\.)adsterra\.com$/, /(^|\.)exoclick\.com$/, /(^|\.)hotjar\.com$/,
  /(^|\.)facebook\.net$/, /(^|\.)taboola\.com$/, /(^|\.)outbrain\.com$/,
];
const BLOCKED_PATH = /\/(vast|vmap|preroll|ads?)\//i;
// Régies « popunder » sur domaines jetables : /3/<32 hex> (balises), /4/<32 hex> (pop-up)
const AD_NETWORK_PATH = /^\/\d\/[0-9a-f]{32}\/?$/i;

const HLS = /\.m3u8(\?|#|&|$)/i;
const DASH = /\.mpd(\?|#|&|$)/i;
const MP4 = /\.mp4(\?|#|&|$)/i;
const MASTER_HINT = /master/i;
const PLAYLIST_HINT = /(playlist|manifest|index)/i;

function baseDomain(host) {
  return String(host || '').toLowerCase().split('.').slice(-2).join('.');
}
function sameSite(a, b) {
  return baseDomain(a) === baseDomain(b);
}

function createClassifier(opts = {}) {
  const allowed = opts.allowedHosts || [];
  const extraHls = opts.extraHlsPattern ? new RegExp(opts.extraHlsPattern, 'i') : null;
  const blockImages = opts.blockImages !== false;
  const blockFonts = opts.blockFonts !== false;
  const blockStyles = opts.blockStylesheets !== false;
  const allowCrossSite = !!opts.allowCrossSiteRedirects;

  const host = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
  const isAllowedHost = (h) => allowed.some((a) => h === a || h.endsWith(`.${a}`));
  const isBlockedUrl = (url) => {
    const h = host(url);
    let p = '';
    try { p = new URL(url).pathname; } catch { /* ignore */ }
    return DEFAULT_BLOCKED.some((r) => r.test(h)) || BLOCKED_PATH.test(url) || AD_NETWORK_PATH.test(p);
  };

  return {
    /** Régie publicitaire connue (liste intégrée ou chemin /ads/, /vast/…). */
    detectAd(url) {
      return isBlockedUrl(url);
    },

    detectStream(url) {
      if (isBlockedUrl(url)) return null;
      if (HLS.test(url)) return 'hls';
      if (DASH.test(url)) return 'dash';
      if (MP4.test(url)) return 'mp4';
      if (extraHls && extraHls.test(url)) return 'hls';
      return null;
    },

    /** resourceType Electron : mainFrame, subFrame, stylesheet, script, image, font, object, xhr, ping, cspReport, media, webSocket, other */
    shouldBlock(url, resourceType) {
      const h = host(url);
      if (!h) return false;
      if (isAllowedHost(h)) return false;
      if (isBlockedUrl(url)) return true;
      if (blockImages && resourceType === 'image') return true;
      if (blockFonts && resourceType === 'font') return true;
      if (blockStyles && resourceType === 'stylesheet') return true;
      if (resourceType === 'ping' || resourceType === 'cspReport') return true;
      return false;
    },

    isNavigationAllowed(targetUrl, pageHost) {
      let u;
      try { u = new URL(targetUrl); } catch { return false; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (isBlockedUrl(targetUrl)) return false;
      if (allowCrossSite || isAllowedHost(u.hostname)) return true;
      return !pageHost || sameSite(u.hostname, pageHost);
    },

    /**
     * Navigation d'une iframe (lecteur). Le premier chargement de l'iframe est toujours permis
     * (l'hébergeur du lecteur est souvent un autre site) ; une iframe déjà chargée qui part vers
     * un autre site juste après un clic est une pub qui détourne le clic.
     */
    isFrameNavigationAllowed(targetUrl, frameUrl, { userTriggered = false } = {}) {
      let u;
      try { u = new URL(targetUrl); } catch { return true; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
      if (isBlockedUrl(targetUrl)) return false;
      if (allowCrossSite || isAllowedHost(u.hostname)) return true;
      let current;
      try { current = new URL(frameUrl); } catch { return true; }
      if (current.protocol !== 'http:' && current.protocol !== 'https:') return true;
      if (sameSite(u.hostname, current.hostname)) return true;
      return !userTriggered;
    },
  };
}

const TYPE_RANK = { hls: 0, dash: 1, mp4: 2 };

function rank(candidates) {
  return [...candidates].sort((a, b) =>
    TYPE_RANK[a.type] - TYPE_RANK[b.type] ||
    (a.type === 'hls' ? masterScore(a.url) - masterScore(b.url) : 0) ||
    a.order - b.order);
}
function masterScore(url) {
  let p = '';
  try { p = new URL(url).pathname; } catch { return 2; }
  if (MASTER_HINT.test(p)) return 0;
  return PLAYLIST_HINT.test(p) ? 1 : 2;
}

module.exports = { createClassifier, rank, sameSite, baseDomain };
