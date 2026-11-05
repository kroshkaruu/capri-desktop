'use strict';

// Her hands inside your apps: she reads what's in the window you're on (its buttons, links, fields and
// text, through macOS's accessibility, the way VoiceOver does), her AI picks the next step, she does
// it, and again, until the job's done. "открой заметки, сделай новую и напиши список покупок",
// "включи третье видео", "нажми подписаться"… Nothing leaves your Mac but the list of what's on screen
// and your words, sent to her AI like a chat message.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { clipboard } = require('electron');

// agent-desktop (github.com/vercel-labs/agent-desktop, Apache-2.0): reads any app's window through
// macOS accessibility and acts on it by reference — buttons, fields, lists, web pages in browsers and
// Electron apps. Bundled in her Resources/hands; without it she falls back to her own JXA reader.
function adPath() {
  const packed = path.join(process.resourcesPath || '', 'hands', 'agent-desktop');
  if (fs.existsSync(packed)) return packed;
  const dev = path.join(__dirname, '..', '..', 'hands', 'agent-desktop');
  return fs.existsSync(dev) ? dev : null;
}

function ad(args, timeout = 20000) {
  const bin = adPath();
  if (!bin) return Promise.resolve({ ok: false, error: { code: 'MISSING' } });
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, cwd: path.dirname(bin) }, (err, out) => {
      try {
        const env = JSON.parse(String(out).trim().split('\n').filter(Boolean).pop());
        return resolve(env);
      } catch {
        resolve({ ok: false, error: { code: 'BAD', message: String(err?.message || out).slice(0, 300) } });
      }
    });
  });
}

const AD_SKIP = /^(menubar|menu|menuitem|menubaritem)$/i;
const AD_TEXT = /textfield|textarea|searchfield|combobox|text_field|text_area|search_field|editable/i;

// agent-desktop's view of a window, in the same shape as look(): elements with a ref
async function adLook(proc) {
  const env = await ad(['snapshot', '--app', proc, '-i', '--compact', '--include-bounds', '--max-depth', '18', '--timeout-ms', '9000'], 30000);
  if (!env?.ok) return { error: env?.error?.code || 'snapshot failed', ad: true };
  const d = env.data || {};
  const out = [];
  const walk = (n, depth) => {
    if (!n || out.length > 260 || depth > 40) return;
    const role = String(n.role || '');
    if (AD_SKIP.test(role)) return;
    const label = [n.name, n.description, n.hint].map((x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 90)).filter((x, j, a) => x && a.indexOf(x) === j).join(' — ');
    const value = String(n.value || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const b = n.bounds || n.ref_bounds;
    if ((n.ref_id && (label || value || AD_TEXT.test(role))) || (!n.ref_id && label && depth > 0)) {
      out.push({
        ref: n.ref_id || null,
        role: role.replace(/^AX/, '').replace(/(^|_)(\w)/g, (_m, _u, c) => c.toUpperCase()),
        label, value,
        text: AD_TEXT.test(role),
        x: b ? Math.round(b.x + b.width / 2) : null,
        y: b ? Math.round(b.y + b.height / 2) : null,
      });
    }
    for (const c of n.children || []) walk(c, depth + 1);
  };
  walk(d.tree, 0);
  return { app: d.app || proc, title: d.window?.title || d.tree?.name || '', elements: out, ad: true };
}

const MAX_STEPS = 15;
const NEVER = /парол|password|карт[аы]\s|card number|cvv|cvc|оплат|купить|buy now|pay|перевести деньги|удалить аккаунт|delete account|очистить корзин|empty trash|стереть|erase/i;

function jxa(script, timeout = 30000) {
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve({ error: String(err.message).slice(0, 300) });
      try { resolve(JSON.parse(String(out))); } catch { resolve({ error: 'bad output' }); }
    });
  });
}

// What's in the front window of `proc` (or of the app in front): [{ id, path, role, label, value }]
function look(proc) {
  return jxa(`
const se = Application('System Events');
const name = ${JSON.stringify(proc || '')};
const p = name ? se.applicationProcesses.byName(name) : se.applicationProcesses.whose({ frontmost: true })[0];
const w = p.windows[0];
let wx = 0, wy = 0, ww = 99999, wh = 99999, title = '';
try { const pos = w.position(), sz = w.size(); wx = pos[0]; wy = pos[1]; ww = sz[0]; wh = sz[1]; } catch (e) {}
try { title = w.name() || ''; } catch (e) {}
const KEEP = ['AXButton','AXLink','AXTextField','AXTextArea','AXSearchField','AXSecureTextField','AXCheckBox','AXRadioButton','AXPopUpButton','AXComboBox','AXTab','AXMenuButton','AXStaticText','AXHeading','AXDisclosureTriangle','AXSlider','AXCell','AXImage','AXSwitch'];
const TEXT = ['AXTextField','AXTextArea','AXSearchField','AXComboBox','AXStaticText','AXHeading','AXSecureTextField'];
const SKIP = ['AXMenuBar','AXMenu','AXMenuItem','AXMenuBarItem'];
const out = [];
let visited = 0;
const clean = (s) => (s === null || s === undefined || s === 'missing value') ? '' : String(s).replace(/\\s+/g, ' ').trim().slice(0, 90);
function walk(c, path, depth) {
  if (depth > 28 || visited > 2500 || out.length > 260) return;
  let kids, n = 0;
  try { kids = c.uiElements; n = kids.length; } catch (e) { return; }
  if (!n) return;
  let roles = [], names = [], descs = [], pos = [], size = [];
  try { roles = kids.role(); } catch (e) { return; }
  try { names = kids.name(); } catch (e) {}
  try { descs = kids.description(); } catch (e) {}
  try { pos = kids.position(); } catch (e) {}
  try { size = kids.size(); } catch (e) {}
  for (let i = 0; i < n && out.length <= 260; i++) {
    visited++;
    const role = roles[i];
    if (SKIP.indexOf(role) >= 0) continue;
    const at = pos[i] || [0, 0], sz = size[i] || [0, 0];
    const seen = sz[0] > 1 && sz[1] > 1 && at[0] + sz[0] > wx && at[0] < wx + ww && at[1] + sz[1] > wy && at[1] < wy + wh;
    if (KEEP.indexOf(role) >= 0 && seen) {
      let label = [clean(names[i]), clean(descs[i])].filter((x, j, a) => x && a.indexOf(x) === j).join(' — ');
      let value = '';
      if (TEXT.indexOf(role) >= 0 && role !== 'AXSecureTextField') { try { value = clean(kids[i].value()); } catch (e) {} }
      if (label || value || TEXT.indexOf(role) >= 0) {
        out.push({ path: path.concat(i), role: role.replace('AX', ''), label: label, value: value, x: Math.round(at[0] + sz[0] / 2), y: Math.round(at[1] + sz[1] / 2) });
      }
    }
    if (role !== 'AXStaticText' && role !== 'AXImage' && depth < 28) walk(kids[i], path.concat(i), depth + 1);
  }
}
try { walk(w, [], 0); } catch (e) {}
JSON.stringify({ app: p.name(), title: title, elements: out });`, 45000);
}

// Does one thing to the element at `path` in the front window of `proc`: press it, click it, or
// click it and paste `text` into it.
function act(proc, el, how) {
  return jxa(`
ObjC.import('CoreGraphics');
const se = Application('System Events');
const p = se.applicationProcesses.byName(${JSON.stringify(proc)});
p.frontmost = true;
delay(0.25);
let e = p.windows[0];
${JSON.stringify(el.path)}.forEach((i) => { e = e.uiElements[i]; });
function click(x, y) {
  const pt = $.CGPointMake(x, y);
  [$.kCGEventMouseMoved, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp].forEach((t) => {
    $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, t, pt, $.kCGMouseButtonLeft));
    delay(0.05);
  });
}
let how = ${JSON.stringify(how)}, done = 'clicked';
if (how === 'press') {
  try { e.actions['AXPress'].perform(); done = 'pressed'; } catch (err) { click(${el.x}, ${el.y}); }
} else {
  try { e.focused = true; } catch (err) {}
  click(${el.x}, ${el.y});
}
JSON.stringify({ ok: true, done: done });`, 20000);
}

// a real mouse click at a point on screen, the app brought forward first
function clickAt(proc, x, y) {
  return jxa(`
ObjC.import('CoreGraphics');
${proc ? `Application('System Events').applicationProcesses.byName(${JSON.stringify(proc)}).frontmost = true; delay(0.25);` : ''}
const pt = $.CGPointMake(${Number(x)}, ${Number(y)});
[$.kCGEventMouseMoved, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp].forEach((t) => {
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, t, pt, $.kCGMouseButtonLeft));
  delay(0.05);
});
JSON.stringify({ ok: true });`, 10000);
}

// press / click / type through whichever reader saw the element
async function doClick(proc, el) {
  if (el.ref) {
    let r = await ad(['click', el.ref]);
    if (!r.ok) r = await ad(['--headed', 'click', el.ref]);
    if (r.ok) return r;
    if (el.x !== null) return clickAt(proc, el.x, el.y);
    return { error: r.error?.code || 'click failed' };
  }
  if (el.path) return act(proc, el, 'press');
  if (el.x !== null) return clickAt(proc, el.x, el.y);
  return { error: 'nothing to click' };
}

async function doType(proc, el, text, enter) {
  let r = { ok: false };
  if (el.ref) {
    r = await ad(['type', el.ref, text]);
    if (!r.ok) r = await ad(['--headed', 'type', el.ref, text]);
    if (!r.ok) r = await ad(['set-value', el.ref, text]);
    if (r.ok && enter) await ad(['press', 'return', '--app', proc]);
    if (r.ok) return r;
    if (el.x !== null) await clickAt(proc, el.x, el.y);
  } else if (el.path) {
    await act(proc, el, 'click');
  } else if (el.x !== null) {
    await clickAt(proc, el.x, el.y);
  }
  await new Promise((res) => setTimeout(res, 300));
  return paste(proc, text, enter);
}

function keyScript(proc, script) {
  return jxa(`
const se = Application('System Events');
${proc ? `se.applicationProcesses.byName(${JSON.stringify(proc)}).frontmost = true; delay(0.25);` : ''}
${script}
JSON.stringify({ ok: true });`, 15000);
}

// typed text goes through the clipboard (then put back): any language, whatever keyboard layout is on
async function paste(proc, text, enter) {
  const before = clipboard.readText();
  clipboard.writeText(text);
  const r = await keyScript(proc, `se.keyCode(9, { using: 'command down' }); delay(0.2); ${enter ? 'se.keyCode(36);' : ''}`);
  setTimeout(() => clipboard.writeText(before), 800);
  return r;
}

const ROLE_RU = { Textfield: 'поле', Textarea: 'текст', Searchfield: 'поиск', Checkbox: 'галочка', Radiobutton: 'выбор', Popupbutton: 'список', Combobox: 'поле', Statictext: 'текст', Scrollarea: 'прокрутка', Menubutton: 'меню',
   Button: 'кнопка', Link: 'ссылка', TextField: 'поле', TextArea: 'текст', SearchField: 'поиск', CheckBox: 'галочка', RadioButton: 'выбор', PopUpButton: 'список', ComboBox: 'поле', Tab: 'вкладка', StaticText: 'текст', Heading: 'заголовок', Cell: 'ячейка', Image: 'картинка', Switch: 'переключатель', Slider: 'ползунок' };

function describe(screen) {
  return screen.elements.map((e, i) => `${i}. ${e.role}${e.label ? ` "${e.label}"` : ''}${e.value ? ` = "${e.value}"` : ''}${e.ref === null && !e.path && e.x === null ? ' (text only)' : ''}`).join('\n');
}

const SYSTEM = 'You operate the apps on the user\'s Mac for them, one step at a time, through what is on screen. '
  + 'Each turn you get the job, the app in front and its window, the steps done so far, and a numbered list of what is in that window (buttons, links, fields, text). '
  + 'Reply with exactly ONE JSON object and nothing else:\n'
  + '{"do":"click","id":N} press element N (a button, link, video, tab, checkbox…)\n'
  + '{"do":"type","id":N,"text":"…","enter":false} click field N and type the text into it (enter:true presses Return after, e.g. to search)\n'
  + '{"do":"scroll","id":N,"dir":"down"} scroll the list/page N (dir: up, down)\n'
  + '{"do":"key","combo":"cmd+n"} press a shortcut in the app in front (cmd+n new, cmd+f find, cmd+l address bar, ctrl+tab next tab, space, return, escape, pagedown, down, cmd+right…)\n'
  + '{"do":"open","app":"Notes"} open or bring forward an app by its macOS name in English (Notes, Safari, Telegram, Spotify, Zen…)\n'
  + '{"do":"wait"} the window is still loading\n'
  + '{"do":"done","said":"…"} the job is done: what you did, in one short Russian sentence, in character (a cheeky cyberpunk girl)\n'
  + '{"do":"stop","said":"…"} you can\'t go on: why, in one short Russian sentence\n'
  + 'Rules: work in the app that fits the job (open it first if it is not in front). Prefer a shortcut when you know one. '
  + 'Never type passwords or card numbers, never pay, buy, subscribe or send money, never delete anything, never send a message to someone unless the job says to and says what. '
  + 'If the same step changed nothing twice, try something else or stop. As soon as the screen shows the job done, say done.';

// The job, step by step. onStep(line) says each step as it goes. Resolves with her last line.
async function run(task, { chat, findApp, openApp, frontApp, onStep, signal }) {
  if (NEVER.test(task)) return { said: 'Такое я руками делать не буду: пароли, оплата и удаление — только сам.' };
  let proc = await frontApp();
  const steps = [];
  let same = 0;
  let last = '';
  for (let i = 0; i < MAX_STEPS; i++) {
    if (signal?.aborted) return { said: 'Остановилась.' };
    let screen = { app: '', title: '', elements: [] };
    if (proc) {
      screen = adPath() ? await adLook(proc) : { error: 'no agent-desktop' };
      if (screen.error || !screen.elements?.length) {
        const old = await look(proc); // her own reader, when agent-desktop can't see it
        if (old.elements?.length || !screen.elements) screen = old;
      }
    }
    if (screen.error && proc) return { said: `Не вижу, что в окне ${proc}: разреши Capri в «Управление устройством и доступ к данным».`, error: screen.error };
    const prompt = `Job: ${task}\nApp in front: ${screen.app || 'none'}${screen.title ? `, window "${screen.title}"` : ''}\n`
      + `Steps so far:\n${steps.length ? steps.map((s, j) => `${j + 1}. ${s}`).join('\n') : 'none'}\n`
      + `On screen:\n${screen.elements?.length ? describe(screen) : '(nothing readable)'}\nThe next step, as one JSON object:`;
    let reply;
    try {
      reply = await chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], signal);
    } catch (err) {
      return { said: `Мой мозг не ответил: ${err.message}` };
    }
    const json = /\{[\s\S]*\}/.exec(String(reply).replace(/<think>[\s\S]*?<\/think>/g, ''))?.[0];
    let step;
    try { step = JSON.parse(json); } catch { steps.push('(that reply wasn\'t one JSON step: nothing happened)'); continue; }
    const key = JSON.stringify(step);
    same = key === last ? same + 1 : 0;
    last = key;
    if (same >= 2) return { said: 'Застряла на одном шаге, дальше сам, ладно?' };
    const el = Number.isInteger(step.id) ? screen.elements?.[step.id] : null;
    const name = el ? `${ROLE_RU[el.role] || el.role}${el.label ? ` «${el.label.slice(0, 40)}»` : ''}` : '';
    switch (step.do) {
      case 'done': return { said: step.said || 'Готово.', done: true };
      case 'stop': return { said: step.said || 'Дальше не могу.' };
      case 'wait':
        await new Promise((r) => setTimeout(r, 1500));
        steps.push('waited');
        break;
      case 'open': {
        const item = await openApp(String(step.app || ''));
        onStep?.(item ? `открываю ${item}` : `не нашла ${step.app}`);
        steps.push(item ? `opened ${item}` : `couldn't find the app ${step.app}`);
        if (item) {
          await new Promise((r) => setTimeout(r, 2000));
          proc = (await findApp(item)) || (await frontApp()) || proc;
        }
        break;
      }
      case 'click': {
        if (!el) { steps.push(`there's no element ${step.id}`); break; }
        if (NEVER.test(el.label)) return { said: `«${el.label}» нажимать не буду — это уже сам.` };
        onStep?.(`нажимаю: ${name}`);
        const r = await doClick(proc, el);
        steps.push(r.error ? `couldn't click ${step.id}` : `clicked ${step.id} (${el.role} "${el.label}")`);
        await new Promise((res) => setTimeout(res, 1200));
        break;
      }
      case 'type': {
        if (!el) { steps.push(`there's no element ${step.id}`); break; }
        if (/secure/i.test(el.role) || NEVER.test(el.label)) return { said: 'В такие поля я не печатаю — это сам.' };
        const text = String(step.text || '');
        onStep?.(`печатаю: «${text.slice(0, 40)}»`);
        const r = await doType(proc, el, text, Boolean(step.enter));
        steps.push(r.error ? `couldn't type in ${step.id}` : `typed "${text.slice(0, 60)}" in ${step.id}${step.enter ? ' and pressed Return' : ''}`);
        await new Promise((res) => setTimeout(res, step.enter ? 1800 : 600));
        break;
      }
      case 'scroll': {
        const dir = step.dir === 'up' ? 'up' : 'down';
        onStep?.(`листаю ${dir === 'up' ? 'вверх' : 'вниз'}`);
        let r = el?.ref ? await ad(['scroll', el.ref, '--direction', dir, '--amount', '5']) : { ok: false };
        if (!r.ok) {
          const k = await require('./system').act({ action: 'keys', app: proc, combo: dir === 'up' ? 'pageup' : 'pagedown' });
          r = { ok: Boolean(k?.done) };
        }
        steps.push(r.ok ? `scrolled ${dir}` : `couldn't scroll`);
        await new Promise((res) => setTimeout(res, 800));
        break;
      }
      case 'key': {
        const combo = String(step.combo || '');
        if (/^cmd\+q$|cmd\+delete|cmd\+backspace|shift\+cmd\+q/i.test(combo)) { steps.push(`refused ${combo}`); break; }
        onStep?.(`жму ${combo}`);
        const r = await require('./system').act({ action: 'keys', app: proc, combo });
        steps.push(r?.done ? `pressed ${combo}` : `couldn't press ${combo}`);
        await new Promise((res) => setTimeout(res, 900));
        break;
      }
      default:
        steps.push(`"${step.do}" isn't a step: nothing happened`);
    }
  }
  return { said: 'Шагов слишком много, остановилась. Глянь, что получилось.' };
}

module.exports = { run, look };
