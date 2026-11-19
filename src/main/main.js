'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, session, shell, Menu } = require('electron');
const { Settings } = require('./settings');
const { Tmdb } = require('./tmdb');
const { SourceRepository } = require('./sources/repository');
const { CompanionServer } = require('./companion/server');
const { installPlaybackHeaders } = require('./playback-headers');
const { setupUpdater } = require('./updater');
const { StreamCache } = require('./resolver/stream-cache');
const { Availability } = require('./resolver/availability');
const { MatchMemory } = require('./resolver/match-memory');
const { renderHtml } = require('./resolver/page-renderer');
const scraper = require('./sources/scraper');

app.setName('RR Streaming');
if (process.platform === 'win32') app.setAppUserModelId('fr.robinrahoual.rrstreaming');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;

  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    scraper.setPageRenderer(renderHtml); // sites construits en JavaScript
    const dataDir = app.getPath('userData');
    const settings = new Settings(dataDir);
    const tmdb = new Tmdb(() => settings.get());
    const repo = new SourceRepository(dataDir);
    repo.load();
    const companion = new CompanionServer(repo);

    win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 640,
      backgroundColor: '#000000',
      title: 'RR Streaming',
      icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    // Liens externes → navigateur ; aucune navigation hors de l'app.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });

    const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
    const playback = installPlaybackHeaders(session.defaultSession, () => (win && !win.isDestroyed() ? win.webContents.id : -1));
    const updater = setupUpdater(send, () => settings.get().autoUpdate);

    const matches = new MatchMemory();
    const streams = new StreamCache(repo, { emit: send, matches });
    const availability = new Availability(repo, { emit: send, matches });
    repo.on('change', () => {
      send('sources:changed', repo.publicState());
      streams.clear();
      availability.clear();
      matches.clear();
    });
    repo.syncIfStale().catch(() => {});

    // -------------------------------------------------------- IPC
    const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (err) {
        return { ok: false, error: err.message, code: err.code, details: err.errors || err.failures || null };
      }
    });

    handle('app:version', () => app.getVersion());
    handle('settings:get', () => settings.get());
    handle('settings:set', (patch) => { tmdb.clear(); return settings.set(patch); });
    handle('tmdb:get', (p, params) => tmdb.get(p, params));

    handle('sources:state', () => repo.publicState());
    handle('sources:addSubscription', (url) => repo.addSubscription(url).then(() => repo.publicState()));
    handle('sources:sync', (id) => repo.sync(id).then(() => repo.publicState()));
    handle('sources:syncAll', () => repo.syncAll());
    handle('sources:toggleSubscription', (id, v) => repo.setSubscriptionEnabled(id, v).then(() => repo.publicState()));
    handle('sources:removeSubscription', (id) => repo.removeSubscription(id).then(() => repo.publicState()));
    handle('sources:toggleProvider', (id, v) => repo.setProviderEnabled(id, v).then(() => repo.publicState()));
    handle('sources:import', (raw) => repo.importDocument(raw));

    handle('companion:start', () => companion.start());
    handle('companion:stop', () => companion.stop());

    // Préchargement : démarré à l'ouverture d'une fiche, réutilisé par « Lire ».
    handle('stream:prefetch', (media, slot) => streams.prefetch(media, slot));
    handle('stream:status', (media) => streams.status(media));
    handle('sources:availability', (list) => availability.check(Array.isArray(list) ? list.slice(0, 30) : []));
    handle('sources:availabilityCancel', () => availability.cancel());

    handle('player:resolve', async (media, opts) => {
      const result = await streams.resolve(media, opts || {});
      playback.start(result.stream.headers);
      return result;
    });
    handle('player:cancel', () => {}); // la résolution continue en arrière-plan : relancer « Lire » la reprend
    handle('player:stop', () => playback.stop());

    handle('updater:check', () => updater.check());
    handle('updater:install', () => updater.install());
    handle('updater:state', () => updater.getState());

    handle('window:fullscreen', () => { win.setFullScreen(!win.isFullScreen()); return win.isFullScreen(); });
    handle('window:setFullscreen', (v) => { win.setFullScreen(!!v); return win.isFullScreen(); });

    app.on('before-quit', () => companion.stop());
  });

  app.on('window-all-closed', () => app.quit());
}
