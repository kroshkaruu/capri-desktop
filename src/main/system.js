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
    const res = await helperJson(['clickwin', name, String(fx), String(fy)], 15000).catch((err) => ({ error: err.message }));
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
    default: return null;
  }
}

module.exports = { act, SETTINGS };
