'use strict';

// Closing an app when you ask her to (chat.js), after you've confirmed with a click. The apps in the
// Dock, by name; closing one like Cmd+Q does (it can still ask you to save), and only if you ask
// again, forcing it.

const mac = require('./mac');

// never these: Finder, her (Capri), Claude (she watches it) and Ollama (she talks through it)
const KEEP = new Set(['finder', 'capri', 'electron', 'claude', 'codex', 'ollama']);

// [{ name, process, label, ids }]: one per app in the Dock ("Spotify", "Discord"...), not the
// background helpers
async function list() {
  const rows = await mac.helperJson(['apps']);
  const apps = new Map();
  for (const { pid, name, bundle } of rows) {
    if (!name || pid === process.pid || KEEP.has(name.toLowerCase())) continue;
    const app = apps.get(name) || { name, process: name, label: name, bundle, ids: [] };
    app.ids.push(pid);
    apps.set(name, app);
  }
  return [...apps.values()];
}

// an app's bundle id (com.apple.Notes), from its Info.plist
function bundleOf(appPath) {
  return new Promise((resolve) => {
    require('node:child_process').execFile('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', `${appPath}/Contents/Info.plist`], { timeout: 5000 },
      (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// The open app that `wanted` names, by its name ("discord", "Apple Music").
async function find(wanted) {
  const key = simple(wanted);
  if (key.length < 2) return null;
  const apps = await list();
  // "телеграм" is Telegram Lite: her Russian names for apps, then any word of the name
  const said = require('./launch').russianNames(wanted).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  const named = apps.find((app) => [app.name, app.label].some((n) => said.some((w) => simple(n).includes(simple(w)) || (simple(n).length >= 3 && simple(w).includes(simple(n))))));
  if (named) return named;
  const score = (app) => {
    const names = [simple(app.name), simple(app.label)].filter(Boolean);
    if (names.includes(key)) return 3;
    if (names.some((n) => n.startsWith(key) || key.startsWith(n))) return 2;
    if (key.length >= 3 && names.some((n) => n.includes(key) || key.includes(n))) return 1;
    return 0;
  };
  const best = apps.map((app) => [score(app), app]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])[0];
  if (best) return best[1];
  // "System Settings" open as «Системные настройки» on a Mac in Russian: the installed app it names, by its bundle id
  const item = await require('./launch').find(wanted).catch(() => null);
  const id = item?.kind === 'app' ? await bundleOf(item.id) : null;
  return (id && apps.find((app) => app.bundle === id)) || null;
}

// Quits it like Cmd+Q would; `force` ends it outright (unsaved work is lost).
// Resolves with what's left: { running } (true when it stayed open, asking to save something say).
async function close(name, { force = false } = {}) {
  const app = (await list()).find((a) => a.process === name);
  if (!app) return { running: false };
  const left = await mac.helper(['quit', ...(force ? ['--force'] : []), ...app.ids.map(String)], 15000);
  return { running: Number(left) > 0 };
}

module.exports = { list, find, close };
