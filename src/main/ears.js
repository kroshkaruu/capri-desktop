'use strict';

// Her ears on a Mac: the CapriEars helper (in the app's Resources) listens to the microphone and
// turns speech into text with Whisper, right on the Mac. Each JSON line it prints goes to her
// window as an 'ears:event' ({ type: 'ready' | 'speech' | 'phrase' | 'status' | 'error', text, code }).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, systemPreferences } = require('electron');

const MODEL = 'ggml-small-q5_1.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL}`;

let child = null;
let wanted = false;
let crashes = 0;
let send = () => {};

function helperDir() {
  const packed = path.join(process.resourcesPath || '', 'ears');
  if (fs.existsSync(path.join(packed, 'CapriEars'))) return packed;
  return path.join(__dirname, '..', '..', 'ears', 'out');
}

function modelPath(dir) {
  const bundled = path.join(dir, MODEL);
  return fs.existsSync(bundled) ? bundled : path.join(app.getPath('userData'), MODEL);
}

const available = () => process.platform === 'darwin' && fs.existsSync(path.join(helperDir(), 'CapriEars'));

async function start(onEvent) {
  if (onEvent) send = onEvent;
  wanted = true;
  if (child) return;
  if (!available()) {
    send({ type: 'error', code: 'missing', text: 'Голосовой чат работает только на Mac.' });
    wanted = false;
    return;
  }
  try {
    // macOS asks once; the helper inherits the answer (it runs inside her app)
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) {
      wanted = false;
      send({ type: 'error', code: 'mic_denied', text: 'Нет доступа к микрофону. Разреши его Capri: Системные настройки → Конфиденциальность и безопасность → Микрофон, потом включи слух снова.' });
      return;
    }
  } catch {
    // older macOS: the helper asks
  }
  if (!wanted || child) return;
  const dir = helperDir();
  const proc = spawn(path.join(dir, 'CapriEars'), [modelPath(dir), MODEL_URL], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
  child = proc;
  let buffer = '';
  let lastCode = null;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'ready') crashes = 0;
        if (event.type === 'error') lastCode = event.code;
        if (proc === child) send(event);
      } catch {
        // not one of its lines
      }
    }
  });
  proc.on('error', (err) => {
    if (proc !== child) return;
    send({ type: 'error', code: 'start', text: `Не получилось включить слух: ${err.message}` });
  });
  proc.on('exit', () => {
    if (proc !== child) return;
    child = null;
    const final = ['mic_denied', 'no_model', 'mic_failed'].includes(lastCode);
    if (wanted && !final && ++crashes <= 5) setTimeout(() => { if (wanted && !child) start(); }, 2000 * crashes);
    else wanted = false;
  });
}

function stop() {
  wanted = false;
  const old = child;
  child = null;
  if (!old) return;
  try { old.stdin.end(); } catch { /* gone */ }
  setTimeout(() => { try { old.kill(); } catch { /* gone */ } }, 500);
}

module.exports = { start, stop, available, on: () => wanted };
