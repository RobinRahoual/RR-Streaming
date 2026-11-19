'use strict';
/**
 * Rejoue les headers capturés (Referer, Origin, User-Agent, Cookie) sur les requêtes du lecteur
 * (manifest + segments, quel que soit l'hôte du CDN) et ouvre le CORS pour l'origine file://.
 * Ne s'applique qu'aux requêtes xhr/media de la fenêtre principale pendant une lecture.
 */
const EXCLUDED_HOSTS = /(^|\.)(themoviedb\.org|tmdb\.org|github\.com|githubusercontent\.com)$/;

function installPlaybackHeaders(ses, getWebContentsId) {
  let active = null; // { headers }

  const applies = (d) =>
    active &&
    (d.resourceType === 'xhr' || d.resourceType === 'media' || d.resourceType === 'other') &&
    d.webContentsId === getWebContentsId() &&
    /^https?:/.test(d.url) &&
    !EXCLUDED_HOSTS.test(new URL(d.url).hostname);

  ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
    if (!applies(d)) return cb({ requestHeaders: d.requestHeaders });
    const h = { ...d.requestHeaders };
    for (const k of Object.keys(h)) if (/^(origin|referer|user-agent|cookie)$/i.test(k)) delete h[k];
    Object.assign(h, active.headers);
    cb({ requestHeaders: h });
  });

  ses.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
    if (!applies(d)) return cb({ responseHeaders: d.responseHeaders });
    const h = { ...d.responseHeaders };
    for (const k of Object.keys(h)) if (/^access-control-allow-(origin|credentials|headers)$/i.test(k)) delete h[k];
    h['Access-Control-Allow-Origin'] = ['*'];
    h['Access-Control-Allow-Headers'] = ['*'];
    cb({ responseHeaders: h });
  });

  return {
    start(headers) { active = { headers: { ...headers } }; },
    stop() { active = null; },
  };
}

module.exports = { installPlaybackHeaders };
