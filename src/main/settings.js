'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = { tmdbKey: '', language: 'fr-FR', autoUpdate: true };

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    try {
      if (fs.existsSync(this.file)) this.data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch { /* défaut */ }
  }
  get() { return { ...this.data }; }
  set(patch) {
    const allowed = Object.keys(DEFAULTS);
    for (const [k, v] of Object.entries(patch || {})) if (allowed.includes(k)) this.data[k] = typeof v === 'string' ? v.trim() : v;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return this.get();
  }
}

module.exports = { Settings };
