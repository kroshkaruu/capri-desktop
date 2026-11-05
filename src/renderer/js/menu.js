// Her menu, drawn like her chat (Night City): the items main.js sends, a click runs them there.
// Submenus open in place, under their item. Esc, a click elsewhere or ✕ closes it.

export class StyledMenu {
  constructor({ host }) {
    this.host = host;
    this.open = new Set(); // ids of the submenus unfolded
    this.items = [];
    this.el = document.createElement('nav');
    this.el.className = 'cmenu';
    this.el.hidden = true;
    this.el.innerHTML = '<div class="cmenu__plate"><header class="cmenu__head"><span class="cmenu__who">CAPRI</span><span class="cmenu__tag">МЕНЮ</span><button class="cmenu__x" type="button" aria-label="Закрыть">✕</button></header><ul class="cmenu__list"></ul></div>';
    document.body.append(this.el);
    this.list = this.el.querySelector('.cmenu__list');
    this.el.querySelector('.cmenu__x').addEventListener('click', () => this.hide());
    this.list.addEventListener('click', (e) => this.clicked(e));
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.el.hidden) this.hide(); });
    window.addEventListener('mousedown', (e) => { if (!this.el.hidden && !this.el.contains(e.target) && !e.target.closest?.('.panel__settings')) this.hide(); }, true);
    host.onMenu?.(({ items, at, refresh }) => this.show(items, refresh ? null : at));
    this.pointer = { x: 0, y: 0 };
    window.addEventListener('mousemove', (e) => { this.pointer = { x: e.clientX, y: e.clientY }; });
  }

  get visible() { return !this.el.hidden; }

  rect() { return this.el.hidden ? null : this.el.getBoundingClientRect(); }

  show(items, at) {
    this.items = items || [];
    this.render();
    if (at === null && !this.el.hidden) return this.place(this.where);
    if (at === null) return undefined; // a refresh while closed
    this.open.clear();
    this.render();
    this.el.hidden = false;
    this.where = at === 'tray' ? { tray: true } : { x: this.pointer.x, y: this.pointer.y };
    this.place(this.where);
    return undefined;
  }

  hide() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.host.menuClosed?.();
  }

  place(where) {
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const pad = 12;
    let x;
    let y;
    if (where?.tray) {
      x = window.innerWidth - w - pad;
      y = pad + 6;
    } else {
      x = (where?.x ?? 0) - w - 16 < pad ? (where?.x ?? 0) + 16 : (where?.x ?? 0) - w - 16;
      y = (where?.y ?? 0) - 40;
    }
    x = Math.max(pad, Math.min(window.innerWidth - w - pad, x));
    y = Math.max(pad, Math.min(window.innerHeight - h - pad, y));
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
  }

  render() {
    const make = (items, depth) => items.map((item) => {
      if (item.type === 'separator') return '<li class="cmenu__sep" role="separator"></li>';
      const sub = item.submenu?.length;
      const unfolded = sub && this.open.has(item.id);
      const mark = item.type === 'checkbox' || item.type === 'radio' ? `<span class="cmenu__mark">${item.checked ? (item.type === 'radio' ? '●' : '✓') : ''}</span>` : '<span class="cmenu__mark"></span>';
      const right = sub ? `<span class="cmenu__more">${unfolded ? '▾' : '▸'}</span>` : item.accelerator ? `<span class="cmenu__key">${esc(item.accelerator)}</span>` : '';
      const row = `<li class="cmenu__item${item.enabled ? '' : ' is-off'}${sub ? ' has-sub' : ''}${item.checked ? ' is-on' : ''}" data-id="${item.id}" data-sub="${sub ? 1 : 0}" data-type="${item.type}" data-depth="${Math.min(depth, 2)}">${mark}<span class="cmenu__label">${esc(item.label)}</span>${right}</li>`;
      return unfolded ? row + make(item.submenu, depth + 1) : row;
    }).join('');
    this.list.innerHTML = make(this.items, 0);
  }

  clicked(e) {
    const li = e.target.closest('.cmenu__item');
    if (!li || li.classList.contains('is-off')) return;
    const id = li.dataset.id;
    if (li.dataset.sub === '1') {
      if (this.open.has(id)) this.open.delete(id); else this.open.add(id);
      this.render();
      this.place(this.where);
      return;
    }
    this.host.menuClick?.(id);
    // a switch stays open to flip others; anything else closes it
    if (li.dataset.type === 'checkbox' || li.dataset.type === 'radio') return;
    this.hide();
  }
}

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
