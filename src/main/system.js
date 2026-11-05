'use strict';

// What her chat can do to your Mac itself: a System Settings page, the battery, disk, memory and IP,
// the volume, a snip, hiding the windows, dark or light mode, and locking, sleeping, shutting down or
// restarting (those last two only after your click in her chat).

const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { shell } = require('electron');
const { osa, helperJson } = require('./mac');

const SETTINGS = {
  bluetooth: 'com.apple.BluetoothSettings', sound: 'com.apple.Sound-Settings.extension', wifi: 'com.apple.wifi-settings-extension',
  network: 'com.apple.Network-Settings.extension', update: 'com.apple.Software-Update-Settings.extension', display: 'com.apple.Displays-Settings.extension',
  notifications: 'com.apple.Notifications-Settings.extension', mouse: 'com.apple.Mouse-Settings.extension', battery: 'com.apple.Battery-Settings.extension',
  power: 'com.apple.Battery-Settings.extension', background: 'com.apple.Wallpaper-Settings.extension', storage: 'com.apple.settings.Storage',
};

const run = (file, args) => new Promise((resolve) => execFile(file, args, { timeout: 15000 }, (err) => resolve(!err)));
const ok = (script) => osa(script).then((out) => out !== null);
let later = null;

async function settings(page) {
  if (!SETTINGS[page]) return false;
  await shell.openExternal(`x-apple.systempreferences:${SETTINGS[page]}`);
  return true;
}

async function info(what) {
  if (what === 'battery') {
    const out = await new Promise((resolve) => execFile('pmset', ['-g', 'batt'], (err, o) => resolve(err ? '' : String(o))));
    const m = /(\d+)%;\s*([^;]+)/.exec(out);
    return m ? { percent: Number(m[1]), charging: !/discharging/i.test(m[2]) } : { none: true };
  }
  if (what === 'disk') {
    try {
      const s = fs.statfsSync('/System/Volumes/Data');
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {
      return null;
    }
  }
  if (what === 'ram') return { total: os.totalmem(), used: os.totalmem() - os.freemem() };
  if (what === 'ip') {
    const a = Object.values(os.networkInterfaces()).flat().find((x) => x && x.family === 'IPv4' && !x.internal && !x.address.startsWith('169.254.'));
    return { ip: a?.address || null };
  }
  return null;
}

async function volume({ level = null, mute = null } = {}) {
  if (Number.isFinite(level)) await osa(`set volume output volume ${Math.round(Math.min(100, Math.max(0, level)))} without output muted`);
  else if (typeof mute === 'boolean') await osa(`set volume output muted ${mute}`);
  const now = Number.parseInt(await osa('output volume of (get volume settings)'), 10);
  return Number.isFinite(now) ? { level: now } : null;
}

function tidy(back) {
  return ok(back
    ? 'tell application "System Events" to set visible of (every application process whose background only is false) to true'
    : 'tell application "System Events" to set visible of (every application process whose visible is true and name is not "Capri" and name is not "Finder") to false');
}

function theme(dark) {
  return ok(`tell application "System Events" to tell appearance preferences to set dark mode to ${Boolean(dark)}`);
}

async function power(action, seconds = 30) {
  if (action === 'cancel') { const had = Boolean(later); clearTimeout(later); later = null; return had; }
  if (action === 'lock') return run('pmset', ['displaysleepnow']);
  if (action === 'sleep') return run('pmset', ['sleepnow']);
  const verb = action === 'shutdown' ? 'shut down' : action === 'restart' ? 'restart' : null;
  if (!verb) return false;
  clearTimeout(later);
  later = setTimeout(() => { later = null; osa(`tell application "System Events" to ${verb}`); }, Math.max(0, seconds) * 1000);
  return true;
}

// VPNs set up in the system (System Settings › VPN: Red Shield, WireGuard, Outline, IKEv2…), switched the
// way their toggle there does: `scutil --nc`. [{ name, status }] with status like 'Connected' or 'Disconnected'.
const scutil = (args) => new Promise((resolve) => execFile('scutil', args, { timeout: 15000 }, (err, out) => resolve(err ? null : String(out))));

async function vpns() {
  const out = await scutil(['--nc', 'list']);
  if (!out) return [];
  return out.split('\n').map((line) => {
    const m = /\(([^)]+)\).*?"([^"]+)"/.exec(line);
    return m ? { status: m[1].trim(), name: m[2] } : null;
  }).filter(Boolean);
}

const simple = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

async function vpn(what = 'status', wanted = '') {
  const list = await vpns();
  if (!list.length) return { none: true };
  const key = simple(wanted);
  const pick = (key && list.find((v) => simple(v.name).includes(key) || key.includes(simple(v.name))))
    || list.find((v) => /^connect/i.test(v.status)) || list[0];
  if (what === 'status') return { name: pick.name, on: /^connected/i.test(pick.status), status: pick.status, all: list.map((v) => v.name) };
  await scutil(['--nc', what === 'off' ? 'stop' : 'start', pick.name]);
  // it takes a moment to connect: the status after it
  let now = pick.status;
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    now = (await vpns()).find((v) => v.name === pick.name)?.status || now;
    if (what === 'off' ? /^disconnected/i.test(now) : /^connected/i.test(now)) break;
  }
  return { name: pick.name, on: /^connected/i.test(now), status: now };
}

// A VPN app that keeps its tunnel to itself (Red Shield VPN…): opened, and its connect (or disconnect)
// button pressed through Accessibility, by the button's name. { app, pressed } or { app, need }.
const VPN_APPS = ['Red Shield VPN', 'Outline', 'Hiddify', 'AmneziaVPN', 'Amnezia', 'Proton VPN', 'NordVPN', 'Surfshark', 'ExpressVPN', 'Windscribe', 'Happ', 'V2Box', 'FoXray', 'Streisand'];

// Where an app draws its own on/off switch, as fractions of its window (title bar included): macOS can't
// press those, so it's a real click there. Red Shield VPN: the big switch in the middle.
const VPN_SWITCH = { 'Red Shield VPN': [0.503, 0.514] };

// The same real click without her helper: JavaScript for Automation, which reaches CoreGraphics.
function clickJxa(name, fx, fy) {
  const script = `
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
const se = Application('System Events');
const proc = se.processes.byName(${JSON.stringify(name)});
proc.frontmost = true;
delay(0.5);
const w = proc.windows[0];
const p = w.position(), z = w.size();
const pt = $.CGPointMake(p[0] + z[0] * ${Number(fx)}, p[1] + z[1] * ${Number(fy)});
const back = $.CGEventGetLocation($.CGEventCreate(null));
[$.kCGEventMouseMoved, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp].forEach((t) => {
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, t, pt, $.kCGMouseButtonLeft));
  delay(0.06);
});
$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, back, $.kCGMouseButtonLeft));
'ok';`;
  return new Promise((resolve) => execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 15000 },
    (err, out) => resolve(err ? { need: /not allowed|assistive|1743|1728/i.test(String(err.message)) ? 'accessibility' : undefined, error: String(err.message).slice(0, 200) } : { clicked: String(out).trim() === 'ok' })));
}

// A VPN up: a tunnel interface (utun, ipsec, ppp, tun) with an IPv4 address.
function tunnelUp() {
  return Object.entries(os.networkInterfaces()).some(([name, list]) => /^(utun|ipsec|ppp|tun|wg)/.test(name)
    && (list || []).some((a) => a.family === 'IPv4' && !a.internal));
}

async function vpnApp(what = 'on') {
  let name = null;
  for (const candidate of VPN_APPS) {
    if (fs.existsSync(`/Applications/${candidate}.app`)) { name = candidate; break; }
  }
  if (!name) return null;
  const before = tunnelUp();
  if ((what === 'on' && before) || (what === 'off' && !before)) return { app: name, already: true, on: before };
  if (VPN_SWITCH[name]) {
    await run('open', ['-a', name]);
    await new Promise((r) => setTimeout(r, 1500));
    const [fx, fy] = VPN_SWITCH[name];
    // her helper's click, else the same through JavaScript for Automation (a helper built before it had one)
    let res = await helperJson(['clickwin', name, String(fx), String(fy)], 15000).catch((err) => ({ error: err.message }));
    if (!res?.clicked && !res?.need) res = await clickJxa(name, fx, fy);
    if (res?.need) { helperJson(['ask-accessibility']).catch(() => {}); return { app: name, ...res }; }
    let now = before;
    for (let i = 0; i < 20 && now === before; i++) { await new Promise((r) => setTimeout(r, 500)); now = tunnelUp(); }
    // out of the way again
    osa(`tell application "System Events" to set visible of process "${name}" to false`);
    return { app: name, ...res, pressed: now !== before ? 'переключатель' : null, on: now };
  }
  await run('open', ['-a', name]);
  await new Promise((r) => setTimeout(r, 2500));
  const wanted = what === 'off'
    ? ['disconnect', 'отключ', 'выключ', 'stop', 'стоп', 'turn off']
    : ['connect', 'подключ', 'включ', 'start', 'старт', 'turn on'];
  const avoid = what === 'off' ? [] : ['disconnect', 'отключ', 'выключ'];
  let res = null;
  for (let i = 0; i < 3 && !(res?.pressed || res?.need); i++) {
    res = await helperJson(['press', name, wanted.join('|'), avoid.join('|')], 15000).catch((err) => ({ error: err.message }));
    if (!res?.pressed && !res?.need) await new Promise((r) => setTimeout(r, 1500)); // its window is still coming up
  }
  if (res?.need) helperJson(['ask-accessibility']).catch(() => {}); // macOS shows its own prompt
  return { app: name, ...res };
}

// A note in Notes (in the default account's Notes folder): a new one, or text added to the end of one
// found by its title. Notes asks once whether Capri may control it.
const html = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
const quoted = (t) => `"${String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

async function note(title, text, append = false) {
  const name = String(title || '').trim().slice(0, 120) || 'Заметка от Капри';
  const body = String(text || '').trim().slice(0, 8000);
  if (append) {
    const out = await osa(`tell application "Notes"
  set found to (every note whose name contains ${quoted(name)})
  if (count of found) is 0 then return "none"
  set n to item 1 of found
  set body of n to (body of n) & ${quoted(`<div>${html(body)}</div>`)}
  return name of n
end tell`, 15000);
    if (out === null) return { need: 'automation' };
    if (out === 'none') return { none: true, title: name };
    return { added: true, title: out };
  }
  const out = await osa(`tell application "Notes" to make new note with properties {body:${quoted(`<h1>${html(name)}</h1><div>${html(body)}</div>`)}}
return "ok"`, 15000);
  return out === null ? { need: 'automation' } : { made: true, title: name };
}

// ---------- inside apps: their keys, their menus, their own volume ----------

const apps = () => require('./apps');
const BROWSERS = ['Zen', 'Google Chrome', 'Safari', 'Firefox', 'Arc', 'Yandex', 'Opera', 'Brave Browser', 'Microsoft Edge', 'Vivaldi'];
const KEY_CODES = { tab: 48, return: 36, enter: 36, esc: 53, escape: 53, space: 49, left: 123, right: 124, down: 125, up: 126, delete: 51, backspace: 51, pageup: 116, pagedown: 121, home: 115, end: 119, f5: 96 };
const LETTER_CODES = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, 1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, '=': 24, 9: 25, 7: 26, '-': 27, 8: 28, 0: 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50 };
const MODS = { cmd: 'command down', command: 'command down', '⌘': 'command down', shift: 'shift down', '⇧': 'shift down', alt: 'option down', opt: 'option down', option: 'option down', '⌥': 'option down', ctrl: 'control down', control: 'control down', '⌃': 'control down' };
// never these, whatever app: what quits, logs out, shuts down, empties or erases
const NEVER_KEYS = new Set(['cmd+q', 'cmd+shift+q', 'cmd+opt+esc', 'cmd+alt+esc', 'ctrl+cmd+q', 'cmd+shift+delete', 'cmd+opt+shift+q', 'cmd+delete', 'cmd+backspace']);
const NEVER_MENU = /выключ|перезагру|завершить сеанс|выйти из|log ?out|shut ?down|restart|sleep|сон|удал|delete|стере|erase|очистить корзин|empty trash|format|формат/i;

async function processOf(name) {
  if (!name) return null;
  const app = await apps().find(String(name)).catch(() => null);
  return app?.process || null;
}

// the browser you're on, else the first one running
async function browser() {
  const front = await osa('tell application "System Events" to get name of first application process whose frontmost is true');
  if (front && BROWSERS.some((b) => front.toLowerCase().includes(b.toLowerCase()))) return front;
  for (const b of BROWSERS) {
    const running = await osa(`tell application "System Events" to exists (first application process whose name contains ${quoted(b)})`);
    if (running === 'true') return osa(`tell application "System Events" to get name of first application process whose name contains ${quoted(b)}`);
  }
  return null;
}

function keystroke(combo) {
  const parts = String(combo).toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean);
  const key = parts.pop();
  const mods = parts.map((m) => MODS[m]).filter(Boolean);
  if (!key) return null;
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  if (KEY_CODES[key] !== undefined) return `key code ${KEY_CODES[key]}${using}`;
  // by the key's place, not its letter: with the Russian layout on, "k" would type something else
  if (LETTER_CODES[key] !== undefined) return `key code ${LETTER_CODES[key]}${using}`;
  if (key.length === 1) return `keystroke ${quoted(key)}${using}`;
  return null;
}

async function keys(appName, combo) {
  const normalized = String(combo).toLowerCase().replace(/\s+/g, '').replace('command', 'cmd').replace('option', 'opt').replace('control', 'ctrl');
  if (NEVER_KEYS.has(normalized)) return { refused: true };
  const stroke = keystroke(combo);
  if (!stroke) return { bad: true };
  const proc = appName ? await processOf(appName) : null;
  if (appName && !proc) return { notOpen: true };
  const out = await osa(`tell application "System Events"
  ${proc ? `set frontmost of process ${quoted(proc)} to true
  delay 0.3` : ''}
  ${stroke}
end tell
return "ok"`, 10000);
  return out === null ? { need: 'accessibility' } : { done: true, app: proc };
}

// a browser tab: next, previous, close, new, reopen, reload, back, forward, or its number
const TABS = { next: 'ctrl+tab', previous: 'ctrl+shift+tab', prev: 'ctrl+shift+tab', close: 'cmd+w', new: 'cmd+t', reopen: 'cmd+shift+t', reload: 'cmd+r', back: 'cmd+[', forward: 'cmd+]' };
async function tab(what) {
  const b = await browser();
  if (!b) return { noBrowser: true };
  const w = String(what).toLowerCase().trim();
  const combo = TABS[w] || (/^[1-9]$/.test(w) ? `cmd+${w}` : null);
  if (!combo) return { bad: true };
  const r = await keys(b, combo);
  return { ...r, app: b };
}

// a menu item: "File > New Window" (or "Файл > Новое окно"), clicked by its titles
async function menu(appName, path) {
  const steps = String(path).split(/\s*[>›→]\s*/).map((t) => t.trim()).filter(Boolean);
  if (steps.length < 2 || steps.length > 3) return { bad: true };
  if (steps.some((t) => NEVER_MENU.test(t))) return { refused: true };
  const proc = await processOf(appName);
  if (!proc) return { notOpen: true };
  const [top, second, third] = steps;
  const target = third
    ? `menu item ${quoted(third)} of menu 1 of menu item ${quoted(second)} of menu 1 of menu bar item ${quoted(top)} of menu bar 1`
    : `menu item ${quoted(second)} of menu 1 of menu bar item ${quoted(top)} of menu bar 1`;
  const out = await osa(`tell application "System Events" to tell process ${quoted(proc)}
  set frontmost to true
  click ${target}
end tell
return "ok"`, 10000);
  return out === null ? { failed: true, app: proc } : { done: true, app: proc };
}

// Spotify's or Music's own volume: a level, or up and down by 10
async function appVolume(appName, value) {
  const which = /музык|music/i.test(appName) && !/spotify|спотиф/i.test(appName) ? 'Music' : 'Spotify';
  const v = String(value).toLowerCase();
  const now = Number.parseInt(await osa(`tell application ${quoted(which)} to sound volume`), 10);
  if (!Number.isFinite(now)) return { notOpen: true, app: which };
  let level = Number.parseInt(v, 10);
  if (/up|громч|\+/.test(v) && !/^\d/.test(v)) level = now + 10;
  if (/down|тише|-/.test(v) && !/^\d/.test(v)) level = now - 10;
  if (!Number.isFinite(level)) return { bad: true };
  level = Math.max(0, Math.min(100, level));
  await osa(`tell application ${quoted(which)} to set sound volume to ${level}`);
  return { done: true, app: which, level };
}

function act(req = {}) {
  switch (req.action) {
    case 'settings': return settings(String(req.page));
    case 'info': return info(String(req.what));
    case 'volume': return volume({ level: Number.isFinite(req.level) ? req.level : null, mute: typeof req.mute === 'boolean' ? req.mute : null });
    case 'snip': return run('screencapture', ['-i', '-c']);
    case 'tidy': return tidy(Boolean(req.back));
    case 'theme': return theme(Boolean(req.dark));
    case 'power': return power(String(req.what), Number(req.seconds) || 0);
    case 'vpn': return vpn(String(req.what || 'status'), String(req.name || ''));
    case 'vpnApp': return vpnApp(String(req.what || 'on'));
    case 'note': return note(req.title, req.text, Boolean(req.append));
    case 'keys': return keys(String(req.app || ''), String(req.combo || ''));
    case 'tab': return tab(String(req.what || ''));
    case 'menu': return menu(String(req.app || ''), String(req.path || ''));
    case 'appVolume': return appVolume(String(req.app || ''), String(req.value || ''));
    default: return null;
  }
}

module.exports = { act, SETTINGS };
