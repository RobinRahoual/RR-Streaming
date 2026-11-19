'use strict';
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

/**
 * Mise à jour automatique via GitHub Releases (configurée par "publish" dans package.json).
 * Téléchargement en arrière-plan, installation à la fermeture ou sur demande.
 */
function setupUpdater(send, isEnabled) {
  let state = { status: 'idle', version: app.getVersion() };
  const emit = (patch) => { state = { ...state, ...patch }; send('updater:state', state); };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => emit({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (i) => emit({ status: 'downloading', available: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => emit({ status: 'up-to-date', checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => emit({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => emit({ status: 'ready', available: i.version }));
  autoUpdater.on('error', (err) => emit({ status: 'error', error: err ? err.message : 'Erreur' }));

  const check = async () => {
    if (!app.isPackaged) { emit({ status: 'dev', error: 'Mises à jour désactivées en mode développement' }); return state; }
    try { await autoUpdater.checkForUpdates(); } catch (err) { emit({ status: 'error', error: err.message }); }
    return state;
  };

  if (isEnabled()) {
    setTimeout(check, 5000);
    setInterval(() => isEnabled() && check(), 4 * 3600 * 1000);
  }

  return {
    check,
    install: () => autoUpdater.quitAndInstall(false, true),
    getState: () => state,
  };
}

module.exports = { setupUpdater };
