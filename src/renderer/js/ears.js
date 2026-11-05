// Her ears (macOS): what the CapriEars helper heard comes here as phrases. "Капри, …" starts a
// conversation (or carries on one), "Капри" alone makes her listen to the next thing you say, and
// after each of her answers she keeps listening a while, so you can go on without her name.

const WAKE = /(?<![\p{L}\p{N}])(?:(?:эй|хей|окей|ок|hey)[\s,]+)?(?:капри|каприй|капре|кэпри|кепри|копри|каприз|capri|kapri|capry)(?![\p{L}\p{N}])/iu;
const JUNK = /^(?:продолжение следует|субтитры|спасибо за просмотр|редактор субтитров|музыка|аплодисменты|смех|угу|ага|м+|э+|а+|о+)[.!?…]*$/iu;
const FOLLOW_MS = 15000; // after her answer, how long she listens without her name
const WAKE_MS = 8000;    // after "Капри" alone

function tidy(text) {
  let rest = String(text || '').replace(/\s+/g, ' ');
  rest = rest.replace(/^[\s,.;:!?…—–-]+|[\s,;:—–-]+$/g, '');
  rest = rest.replace(/^(?:пожалуйста|слушай|послушай)[\s,]+/i, '').trim();
  if (/^[.!?…]*$/.test(rest)) return '';
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export function woke(heard) {
  const text = String(heard || '').replace(/ё/g, 'е').replace(/Ё/g, 'Е');
  const m = WAKE.exec(text);
  if (!m) return null;
  return tidy(text.slice(0, m.index) + text.slice(m.index + m[0].length));
}

export class Ears {
  constructor({ chat, panel, capri, host }) {
    this.chat = chat;
    this.panel = panel;
    this.capri = capri;
    this.host = host;
    this.wakeUntil = 0;
    this.followUntil = 0;
    this.told = false;
    this.busy = false;
    this.placeholder = null;
    this.restore = null;
    host.onEars?.((event) => this.on(event));
  }

  on(event = {}) {
    if (event.type === 'ready') {
      // her chat just opened: say it, no name needed
      this.followUntil = performance.now() + 15000;
      this.hint('🎙 Слушаю — говори', 15000);
      return;
    }
    if (event.type === 'status' || event.type === 'error') {
      if (this.chat.open) return this.hint(`🎙 ${event.text || 'С микрофоном что-то не так.'}`, 12000);
      this.panel.say({ kind: 'info', face: event.type === 'error' ? 'wide' : 'aside', line: event.text || 'С микрофоном что-то не так.', hold: event.type === 'error' ? 12000 : 8000 });
      return;
    }
    if (event.type === 'speech') {
      if (this.listening()) this.hint('🎙 Слушаю…');
      return;
    }
    if (event.type === 'phrase') this.phrase(String(event.text || '')).catch((err) => console.warn('[capri] ears', err));
  }

  // her chat open: what you say right away, or after her answer, needs no name
  listening() {
    const now = performance.now();
    return this.chat.open && (now < this.wakeUntil || now < this.followUntil);
  }

  // the chat box says she's listening, and goes back to what it said after a while
  hint(text, ms = 0) {
    const input = this.panel.chatInput;
    if (!input || !this.chat.open) return;
    if (this.placeholder === null) this.placeholder = input.placeholder;
    input.placeholder = text;
    clearTimeout(this.restore);
    if (ms) this.restore = setTimeout(() => this.unhint(), ms);
  }

  unhint() {
    clearTimeout(this.restore);
    const input = this.panel.chatInput;
    if (input && this.placeholder !== null) input.placeholder = this.placeholder;
    this.placeholder = null;
  }

  async phrase(heard) {
    const text = heard.trim();
    if (!this.chat.open || !text || JUNK.test(text)) return; // her chat closed: she isn't listening at all
    const command = woke(text);
    const now = performance.now();
    let said = null;
    if (command !== null) {
      if (!command) {
        // just her name: she perks up and listens to the next thing you say
        this.wakeUntil = now + WAKE_MS;
        this.capri.perform?.('hop');
        if (!this.chat.open) await this.chat.start();
        this.hint('🎙 Да? Слушаю…', WAKE_MS);
        return;
      }
      said = command;
    } else if (this.listening()) {
      // carrying on the conversation: a couple of words at least, so a cough or her own blips don't count
      if (tidy(text).length < 4) return;
      said = tidy(text);
    } else {
      return;
    }
    this.host.log?.(`ears, said to her: ${JSON.stringify(said)}`); // only what was meant for her, never the room
    // you're typing to her: what she heard isn't for her
    if (this.chat.open && this.panel.chatInput?.value.trim()) return;
    this.wakeUntil = 0;
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.chat.open) {
        await this.chat.start();
        if (!this.chat.open) return; // no AI set up yet: her setup panel is up instead
      }
      // she's still answering the last thing: once she's done
      for (let i = 0; i < 120 && this.chat.turn; i++) await new Promise((r) => setTimeout(r, 250));
      this.unhint();
      await this.chat.send(said);
      if (this.chat.open) {
        this.followUntil = performance.now() + FOLLOW_MS;
        this.hint('🎙 Слушаю дальше — можно без «Капри»', FOLLOW_MS);
      }
    } finally {
      this.busy = false;
    }
  }
}
