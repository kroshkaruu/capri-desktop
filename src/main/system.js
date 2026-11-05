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

function act(req = {}) {
  switch (req.action) {
    case 'settings': return settings(String(req.page));
    case 'info': return info(String(req.what));
    case 'volume': return volume({ level: Number.isFinite(req.level) ? req.level : null, mute: typeof req.mute === 'boolean' ? req.mute : null });
    case 'snip': return run('screencapture', ['-i', '-c']);
    case 'tidy': return tidy(Boolean(req.back));
    case 'theme': return theme(Boolean(req.dark));
    case 'power': return power(String(req.what), Number(req.seconds) || 0);
    default: return null;
  }
}

module.exports = { act, SETTINGS };
