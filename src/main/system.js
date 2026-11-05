'use strict';

// What her chat can do to your Mac itself: a System Settings page, the battery, disk, memory and IP,
// the volume, a snip, hiding the windows, dark or light mode, and locking, sleeping, shutting down or
// restarting (those last two only after your click in her chat).

const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { shell } = require('electron');
const { osa } = require('./mac');

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

async function vpnApp(what = 'on') {
  let name = null;
  for (const candidate of VPN_APPS) {
    if (fs.existsSync(`/Applications/${candidate}.app`)) { name = candidate; break; }
  }
  if (!name) return null;
  await run('open', ['-a', name]);
  await new Promise((r) => setTimeout(r, 2500));
  const words = what === 'off'
    ? ['disconnect', 'отключ', 'stop', 'выключ', 'стоп', 'turn off']
    : ['connect', 'подключ', 'start', 'включ', 'старт', 'turn on'];
  const avoid = what === 'off' ? [] : ['disconnect', 'отключ', 'выключ'];
  const list = (a) => `{${a.map((w) => `"${w}"`).join(', ')}}`;
  // every button and checkbox in its windows (and its menu-bar window), by name, title or description
  const script = `
set wanted to ${list(words)}
set avoid to ${list(avoid)}
tell application "System Events"
  if not (exists process "${name}") then return "noprocess"
  tell process "${name}"
    set found to {}
    repeat with w in windows
      try
        set found to found & (every UI element of entire contents of w whose role is "AXButton" or role is "AXCheckBox" or role is "AXSwitch")
      end try
    end repeat
    repeat with b in found
      set label to ""
      try
        set label to label & " " & (name of b as text)
      end try
      try
        set label to label & " " & (title of b as text)
      end try
      try
        set label to label & " " & (description of b as text)
      end try
      ignoring case
        set bad to false
        repeat with x in avoid
          if label contains x then set bad to true
        end repeat
        if not bad then
          repeat with x in wanted
            if label contains x then
              click b
              return "pressed:" & label
            end if
          end repeat
        end if
      end ignoring
    end repeat
    if (count of found) is 1 then
      click item 1 of found
      return "pressed: переключатель"
    end if
    return "nobutton:" & (count of found)
  end tell
end tell`;
  const out = await osa(script, 10000);
  if (out === null) return { app: name, need: 'accessibility' };
  if (out.startsWith('pressed:')) return { app: name, pressed: out.slice(8).trim().slice(0, 60) || 'кнопку' };
  return { app: name, note: out };
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
