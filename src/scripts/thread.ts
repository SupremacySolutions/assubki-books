/**
 * The order page, kept up to date without a reload.
 *
 * This owns **the** poll. There used to be an inline one on the page that
 * watched only the status; the thread needs the same request, so it was moved
 * here and given a second job rather than a second timer. Everything that made
 * the original careful is kept: it runs only while the tab is visible, only on
 * an order that is still live, never twice at once, and never for more than an
 * hour.
 *
 * Everything here is an enhancement. With this file removed the page still
 * works: the compose box is a plain form that posts and reloads, and the
 * customer sees the thread on the way back.
 */

const root = document.querySelector<HTMLElement>('[data-order-status]');
const section = document.querySelector<HTMLElement>('[data-thread]');

if (root) {
  const status = root.getAttribute('data-order-status') ?? '';
  /*
   * Looked up when it is needed, never captured.
   *
   * A thread that starts empty renders a paragraph and no list, so a constant
   * taken here was null for the life of the page - `ensureList()` builds one on
   * the first message but could not write it back. `newest()` then stayed at
   * zero and every poll asked the server for the whole conversation again,
   * every five seconds for an hour.
   */
  const listNow = () => section?.querySelector<HTMLOListElement>('[data-thread-list]') ?? null;
  const form = section?.querySelector<HTMLFormElement>('[data-thread-form]') ?? null;

  /*
   * Two speeds.
   *
   * Five seconds is what a conversation needs and twenty is what a status bar
   * needs, so the page pays the faster rate only while the thread is actually
   * being looked at - in the viewport, or with the cursor in the box. Someone
   * reading the top of a long order page is not in a conversation and should
   * not be polling like one. The group basket already polls at 5 s, so the
   * faster rate is a known cost rather than a new one.
   */
  const SLOW = 20000;
  const FAST = 5000;
  const UNTIL = Date.now() + 3600000;

  const live = ['requested', 'awaiting_payment', 'paid', 'dispatched'];
  const watching = live.includes(status);

  let attending = false;
  let every = SLOW;
  let timer: number | null = null;
  let checking = false;

  /**
   * The newest message already on the page, so the poll asks for less.
   *
   * The id, not the time it was written. `created_at` is whole seconds, and two
   * messages inside one second - a Telegram media group is the easy way to get
   * there - made the cursor ambiguous: the server read it as "you are already
   * up to date" and the second message stayed invisible until a reload.
   */
  const newest = () => {
    const items = listNow()?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [];
    let id = 0;
    for (const el of items) id = Math.max(id, Number(el.dataset.messageId ?? 0));
    return id;
  };

  const params = () => {
    const query = new URLSearchParams(location.search);
    query.set('since', String(newest()));
    return query.toString();
  };

  const check = async () => {
    if (checking || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      const res = await fetch(`/api/orders/status?${params()}`);
      const data = await res.json();

      // A status move rewrites the whole page - the journey bar, the payment
      // panel, what the customer is being asked to do - so it is a reload
      // rather than something to patch in.
      if (data.status && data.status !== status) {
        location.reload();
        return;
      }
      if (Array.isArray(data.messages) && data.messages.length) {
        for (const message of data.messages) append(message);
      }
    } catch {
      /* offline or blocked: leave the page exactly as it is */
    } finally {
      checking = false;
    }
  };

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const start = () => {
    if (!watching || Date.now() > UNTIL) return;
    stop();
    timer = window.setInterval(() => (Date.now() > UNTIL ? stop() : check()), every);
  };

  const setPace = (fast: boolean) => {
    const wanted = fast ? FAST : SLOW;
    if (wanted === every) return;
    every = wanted;
    if (timer !== null) start();
  };

  // Coming back to the tab is the likeliest moment for something to have
  // happened, so ask straight away rather than waiting out the interval.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      check();
      start();
    } else stop();
  });

  if (section && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        attending = entries.some((e) => e.isIntersecting);
        setPace(attending);
      },
      { threshold: 0.1 },
    );
    observer.observe(section);
  }

  form?.addEventListener('focusin', () => setPace(true));

  start();

  // -------------------------------------------------------------------------
  // Drawing a message
  // -------------------------------------------------------------------------

  interface Incoming {
    id: number;
    sender: 'customer' | 'owner';
    via: 'web' | 'telegram';
    body: string | null;
    image_key: string | null;
    had_image: number;
    created_at: number;
  }

  const side = section?.dataset.side ?? 'customer';

  const when = (at: number) => {
    const date = new Date(at * 1000);
    const today = new Date();
    const sameDay =
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear();
    return date.toLocaleString('en-GB', {
      ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  /**
   * Builds the bubble node for node, matching Thread.astro.
   *
   * Built with `textContent` throughout rather than a template string: a
   * message is somebody else's words, and the one thing this must never do is
   * hand them to the parser as markup.
   */
  function bubble(message: Incoming): HTMLLIElement {
    const ours = message.sender === side;
    const item = document.createElement('li');
    item.className = `flex ${ours ? 'justify-end' : 'justify-start'}`;
    item.dataset.messageId = String(message.id);
    item.dataset.messageAt = String(message.created_at);

    const box = document.createElement('div');
    box.className =
      'max-w-[85%] sm:max-w-[75%] rounded-[12px] px-3.5 py-2.5 ' +
      (ours
        ? 'bg-[var(--color-navy)] text-white'
        : 'bg-[var(--color-paper-raised)] border border-[var(--color-rule-soft)]');

    if (message.body) {
      const p = document.createElement('p');
      p.className = 'text-[14.5px] leading-relaxed whitespace-pre-line break-words';
      p.textContent = message.body;
      box.append(p);
    }

    if (message.image_key) {
      const query = new URLSearchParams(location.search);
      query.set('id', String(message.id));
      const href = `/api/orders/proof?${query.toString()}`;
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = message.body ? 'block mt-2' : 'block';
      const img = document.createElement('img');
      img.src = href;
      img.alt = 'Photo sent with this message';
      img.className = 'rounded-[8px] max-h-64 w-auto';
      link.append(img);
      box.append(link);
    }

    if (!message.image_key && message.had_image === 1) {
      const gone = document.createElement('p');
      gone.className = `text-[13px] italic opacity-75${message.body ? ' mt-1.5' : ''}`;
      gone.textContent = 'Photo removed - this order closed over six months ago.';
      box.append(gone);
    }

    const stamp = document.createElement('p');
    stamp.className = `mt-1.5 text-[11.5px] tabular-nums ${
      ours ? 'text-white/65' : 'text-[var(--color-ink-faint)]'
    }`;
    stamp.textContent = when(message.created_at) + (message.via === 'telegram' ? ' · via Telegram' : '');
    box.append(stamp);

    item.append(box);
    return item;
  }

  /** Appends, unless it is already there - the poll and the send can race. */
  function append(message: Incoming): void {
    const target = ensureList();
    if (!target) return;
    if (target.querySelector(`[data-message-id="${message.id}"]`)) return;
    target.append(bubble(message));
    target.scrollTop = target.scrollHeight;
  }

  /**
   * The list to append into, made if the thread was empty.
   *
   * An empty thread renders a paragraph rather than a list, so the first
   * message to arrive has nowhere to go until that paragraph is replaced.
   */
  function ensureList(): HTMLOListElement | null {
    const existing = listNow();
    if (existing) return existing;
    const panel = section?.querySelector('div');
    if (!panel) return null;
    panel.querySelector('p')?.remove();
    const made = document.createElement('ol');
    made.className = 'max-h-[26rem] overflow-y-auto p-4 space-y-3';
    made.setAttribute('data-thread-list', '');
    panel.prepend(made);
    return made;
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  const box = form?.querySelector<HTMLTextAreaElement>('textarea[name="body"]') ?? null;
  const send = form?.querySelector<HTMLButtonElement>('[data-thread-send]') ?? null;
  const problem = section?.querySelector<HTMLElement>('[data-thread-error]') ?? null;
  const picker = form?.querySelector<HTMLInputElement>('[data-thread-image]') ?? null;
  const preview = form?.querySelector<HTMLElement>('[data-thread-preview]') ?? null;

  const say = (text: string | null) => {
    if (!problem) return;
    problem.textContent = text ?? '';
    problem.classList.toggle('hidden', !text);
  };

  /*
   * Shrinks the screenshot before it leaves the phone.
   *
   * A phone screenshot is 1170px wide and often two or three megabytes, and a
   * modern Android hands back HEIC, which the server does not accept. Drawing
   * it through a canvas solves both at once: the decode does the format
   * conversion, and the re-encode does the size. The listing editor does the
   * same thing to the owner's camera photos.
   *
   * Bigger than the 800px used for covers - the whole point of this image is
   * that a payment reference stays legible in it.
   *
   * A failure here returns the original untouched rather than refusing it: a
   * screenshot that reaches the shop large is worth far more than one that did
   * not go at all, and the server still has the 8 MB cap behind it.
   */
  const MAX_EDGE = 1400;

  async function shrink(file: File): Promise<File> {
    if (!('createImageBitmap' in window)) return file;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(MAX_EDGE / bitmap.width, MAX_EDGE / bitmap.height, 1);

      // Already small enough and already a format the server takes: leave it be.
      if (scale === 1 && file.size < 1_500_000 && file.type !== 'image/heic') return file;

      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, w, h);

      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.85));
      return blob ? new File([blob], 'screenshot.webp', { type: 'image/webp' }) : file;
    } catch {
      return file;
    }
  }

  /** What will actually be sent, once it has been through the canvas. */
  let prepared: File | null = null;

  const chosen = section?.querySelector<HTMLElement>('[data-thread-chosen]') ?? null;
  const clear = section?.querySelectorAll<HTMLButtonElement>('[data-thread-clear]') ?? [];

  /** Puts the box back to empty-handed, from either the button or a send. */
  const dropAttachment = () => {
    if (picker) picker.value = '';
    prepared = null;
    preview?.classList.add('hidden');
    preview?.classList.remove('flex');
    const img = preview?.querySelector('img');
    if (img) img.removeAttribute('src');
    if (chosen) {
      chosen.textContent = '';
      chosen.classList.add('hidden');
    }
  };

  for (const button of clear) button.addEventListener('click', dropAttachment);

  /* A local preview needs no upload and no round trip - `img-src` allows
     `blob:` for exactly this. The paperclip gives no other sign it took
     something, so this is the only confirmation the customer gets. */
  picker?.addEventListener('change', async () => {
    const file = picker.files?.[0] ?? null;
    if (!file) {
      dropAttachment();
      return;
    }

    const img = preview?.querySelector('img');
    if (preview && img) {
      img.src = URL.createObjectURL(file);
      img.onload = () => URL.revokeObjectURL(img.src);
      preview.classList.remove('hidden');
      preview.classList.add('flex');
    } else if (chosen) {
      // No preview element to draw into: say the name at least.
      chosen.textContent = file.name;
      chosen.classList.remove('hidden');
    }

    prepared = await shrink(file);
  });

  form?.addEventListener('submit', async (event) => {
    if (!box) return;
    event.preventDefault();
    say(null);

    const typed = box.value;
    const data = new FormData(form);

    // FormData took whatever the input holds; swap in the re-encoded copy so a
    // three-megabyte HEIC is not what actually goes up.
    if (prepared && picker?.files?.length) data.set('image', prepared, prepared.name);

    if (send) send.disabled = true;

    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: data,
      });
      const result = await res.json().catch(() => null);

      if (!res.ok || !result?.ok) {
        /*
         * The words stay in the box. This page gets used on a phone in a shop
         * with bad signal, and a message that did not go must not take what
         * somebody wrote with it.
         */
        say(result?.error ?? 'That did not send. Your words are still here - please try again.');
        return;
      }

      append(result.message);
      box.value = '';
      dropAttachment();
    } catch {
      box.value = typed;
      say('That did not send. Your words are still here - please try again.');
    } finally {
      if (send) send.disabled = false;
    }
  });
}
