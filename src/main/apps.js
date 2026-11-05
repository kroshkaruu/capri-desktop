'use strict';

// Closing an app when you ask her to (chat.js), after you've confirmed with a click. The apps with
// a window, by name; closing one the way its own close button does (it can still ask you to save),
// and only if you ask again, forcing it. Windows only.

const { execFile } = require('node:child_process');

// never these: the desktop itself, Windows' own pieces, her (Capri), Claude (she watches it) and
// Ollama (she talks through it)
const KEEP = new Set([
  'explorer', 'applicationframehost', 'textinputhost', 'shellexperiencehost', 'startmenuexperiencehost',
  'searchhost', 'searchapp', 'lockapp', 'dwm', 'capri', 'electron', 'claude', 'codex', 'ollama', 'ollama app',
]);

function powershell(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`,
    ], { windowsHide: true, timeout }, (err, out) => (err ? reject(err) : resolve(out.trim())));
  });
}

const MAC = process.platform === 'darwin';

function osascript(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout }, (err, out) => (err ? reject(err) : resolve(String(out).trim())));
  });
}

// macOS: the apps in the Dock (not background ones), through System Events
async function listMac() {
  const out = await osascript([
    'set out to ""',
    'tell application "System Events"',
    'repeat with p in (every application process whose background only is false)',
    'set out to out & (name of p as text) & tab & (unix id of p as text) & linefeed',
    'end repeat',
    'end tell',
    'return out',
  ].join('\n'));
  const apps = new Map();
  for (const line of out.split(/\r?\n/)) {
    const [name, pid] = line.split('\t');
    const id = Number(pid);
    if (!name || !id || id === process.pid || KEEP.has(name.toLowerCase()) || /^finder$/i.test(name)) continue;
    const app = apps.get(name) || { name, process: name, label: name, ids: [] };
    app.ids.push(id);
    apps.set(name, app);
  }
  return [...apps.values()];
}

// [{ name, process, ids }]: one per program with a window open ("AM Music", "Discord"...)
async function list() {
  if (MAC) return listMac();
  if (process.platform !== 'win32') return [];
  const out = await powershell(
    'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | '
    + 'ForEach-Object { [pscustomobject]@{ id = $_.Id; name = $_.ProcessName; label = $_.Description } } | '
    + 'ConvertTo-Json -Compress',
  );
  const rows = [].concat(out ? JSON.parse(out) : []);
  const apps = new Map();
  for (const { id, name, label } of rows) {
    if (id === process.pid || KEEP.has(name.toLowerCase())) continue;
    const app = apps.get(name) || { name, process: name, label: label || '', ids: [] };
    app.ids.push(id);
    apps.set(name, app);
  }
  return [...apps.values()];
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// The open app that `wanted` names, by its name or its description ("am music", "YouTube Music").
async function find(wanted) {
  const key = simple(wanted);
  if (key.length < 2) return null;
  const apps = await list();
  if (MAC) {
    // "телеграм" is Telegram Lite: her Russian names for apps, then any word of the name
    const said = require('./launch').russianNames(wanted).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
    const hit = apps.find((app) => said.some((w) => simple(app.name).includes(simple(w)) || simple(w).includes(simple(app.name))));
    if (hit) return hit;
  }
  const score = (app) => {
    const names = [simple(app.name), simple(app.label)].filter(Boolean);
    if (names.includes(key)) return 3;
    if (names.some((n) => n.startsWith(key) || key.startsWith(n))) return 2;
    if (key.length >= 3 && names.some((n) => n.includes(key) || key.includes(n))) return 1;
    return 0;
  };
  const best = apps.map((app) => [score(app), app]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])[0];
  return best ? best[1] : null;
}

// Closes it like its close button would; `force` ends it outright (unsaved work is lost).
// Resolves with what's left: { running } (true when it stayed open, or hid in the tray).
async function close(name, { force = false } = {}) {
  const app = (await list()).find((a) => a.process === name);
  if (!app) return { running: false };
  if (MAC) {
    if (force) for (const id of app.ids) { try { process.kill(id, 'SIGKILL'); } catch { /* gone */ } }
    else await osascript(`tell application "${name.replace(/"/g, '\\"')}" to quit`).catch(() => null);
    await new Promise((r) => setTimeout(r, force ? 600 : 2500));
    return { running: (await list()).some((a) => a.process === name) };
  }
  const ids = app.ids.join(',');
  const out = await powershell(force
    ? `Stop-Process -Id ${ids} -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 600; `
      + `@(Get-Process -Id ${ids} -ErrorAction SilentlyContinue).Count`
    : `foreach ($p in @(Get-Process -Id ${ids} -ErrorAction SilentlyContinue)) { [void]$p.CloseMainWindow() }; `
      + 'Start-Sleep -Milliseconds 2500; '
      + `@(Get-Process -Name '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue).Count`);
  return { running: Number(out) > 0 };
}

module.exports = { list, find, close, powershell, osascript, MAC };
