'use strict';

// Her updates: the newest build on GitHub (the fork's releases), installed with one click. The
// install script downloads it, swaps the app in Applications, signs it with the same signature as
// before (so macOS keeps her permissions) and opens her again.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const REPO = 'kroshkaruu/capri-desktop';
const PREFIX = 'capri-mac-';

const number = (tag) => Number(String(tag || '').split('-').pop()) || 0;

// this build's own tag (written into package.json by the build)
function current() {
  try {
    return require(path.join(app.getAppPath(), 'package.json')).capriBuild || null;
  } catch {
    return null;
  }
}

// { tag, url } of a newer build, or null
async function check() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
    headers: { 'user-agent': 'Capri-Desktop', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub: ${res.status}`);
  const list = (await res.json()).filter((r) => String(r.tag_name).startsWith(PREFIX) && !r.draft);
  const newest = list.sort((a, b) => number(b.tag_name) - number(a.tag_name))[0];
  if (!newest) return null;
  const asset = (newest.assets || []).find((a) => /\.zip$/i.test(a.name));
  const mine = current();
  if (!asset || (mine && number(newest.tag_name) <= number(mine))) return null;
  return { tag: newest.tag_name, build: number(newest.tag_name), url: asset.browser_download_url };
}

function script() {
  const packed = path.join(process.resourcesPath || '', 'update', 'install.sh');
  return fs.existsSync(packed) ? packed : path.join(__dirname, '..', '..', 'mac', 'install.sh');
}

// starts the install script on its own (it waits for her to quit), then she quits
function install(update) {
  const child = spawn('/bin/bash', [script(), update.url, String(process.pid)], { detached: true, stdio: 'ignore' });
  child.unref();
  setTimeout(() => app.quit(), 400);
}

module.exports = { check, install, current };
