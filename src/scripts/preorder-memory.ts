/**
 * The pre-order forms, remembering who you are on this device.
 *
 * Five books on the page meant typing a name and an email five times. After
 * the first, they are kept in this browser's storage and filled in for you,
 * with the two fields folded behind "Registering as …". A book this browser
 * has registered for shows the number asked for, with a way to change it,
 * instead of an empty form that suggests it was never sent.
 *
 * Only ever what this browser sent - nothing is read back from the server,
 * and other people's numbers are never shown. Storage can be refused (private
 * windows, blocked site data), and then every form simply stays as it is.
 */

const ME = 'asb-preorder-me';
const asked = (id: string) => `asb-preorder-${id}`;

interface Me {
  name: string;
  email: string;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage refused: the forms work as before. */
  }
}

const blocks = [...document.querySelectorAll<HTMLElement>('[data-preorder]')];
const pill = document.querySelector<HTMLElement>('[data-registering]');

/** "a***@gmail.com" - enough to recognise, not enough to read over a shoulder. */
const masked = (email: string) => email.replace(/^(.)[^@]*/, '$1***');

function paint(): void {
  const me = read<Me>(ME);
  if (pill) {
    pill.hidden = !me;
    const who = pill.querySelector<HTMLElement>('[data-registering-who]');
    if (who && me) who.textContent = `${me.name} · ${masked(me.email)}`;
  }

  for (const block of blocks) {
    const id = block.dataset.preorder ?? '';
    const form = block.querySelector<HTMLFormElement>('form[data-interest]');
    if (!form) continue;

    for (const field of block.querySelectorAll<HTMLElement>('[data-who]')) field.hidden = Boolean(me);
    const name = form.querySelector<HTMLInputElement>('input[name="name"]');
    const email = form.querySelector<HTMLInputElement>('input[name="email"]');
    if (me && name && email) {
      name.value = me.name;
      email.value = me.email;
    }

    // A refused answer means the number was not recorded, whatever was kept.
    if (block.dataset.answered === 'bad') write(asked(id), null);
    const copies = read<number>(asked(id));
    const box = block.querySelector<HTMLElement>('[data-asked]');
    const line = block.querySelector<HTMLElement>('[data-asked-line]');
    const showAsked = Boolean(copies && me && block.dataset.changing !== '1');
    if (box) box.hidden = !showAsked;
    form.hidden = showAsked;
    if (line && copies) line.textContent = `You asked for ${copies} ${copies === 1 ? 'copy' : 'copies'}.`;
    const input = form.querySelector<HTMLInputElement>('input[name="copies"]');
    if (input && copies && block.dataset.changing === '1') input.value = String(copies);
  }
}

for (const block of blocks) {
  const id = block.dataset.preorder ?? '';
  const form = block.querySelector<HTMLFormElement>('form[data-interest]');
  if (!form) continue;

  form.addEventListener('submit', () => {
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    const email = String(data.get('email') ?? '').trim();
    const copies = Number(data.get('copies'));
    if (name && email) write(ME, { name, email });
    if (Number.isInteger(copies) && copies > 0) write(asked(id), copies);
  });

  block.querySelector('[data-change]')?.addEventListener('click', () => {
    block.dataset.changing = '1';
    paint();
    form.querySelector<HTMLInputElement>('input[name="copies"]')?.focus();
  });

  // The − and + either side of the number.
  const input = form.querySelector<HTMLInputElement>('input[name="copies"]');
  for (const button of form.querySelectorAll<HTMLButtonElement>('[data-step]')) {
    button.addEventListener('click', () => {
      if (!input) return;
      const max = Number(input.max) || 50;
      const next = Math.min(max, Math.max(1, (Number(input.value) || 1) + Number(button.dataset.step)));
      input.value = String(next);
    });
  }
}

pill?.querySelector('[data-not-me]')?.addEventListener('click', () => {
  write(ME, null);
  for (const block of blocks) {
    write(asked(block.dataset.preorder ?? ''), null);
    const form = block.querySelector<HTMLFormElement>('form[data-interest]');
    form?.querySelectorAll<HTMLInputElement>('input[name="name"], input[name="email"]').forEach((i) => {
      i.value = '';
    });
  }
  paint();
});

paint();
