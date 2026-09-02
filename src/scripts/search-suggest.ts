/**
 * Results as you type, under the search box.
 *
 * An enhancement and nothing more: the form it attaches to is an ordinary GET
 * to /catalogue and still is. With this file removed, or JavaScript off, or the
 * request failing, typing and pressing Enter does exactly what it did before.
 *
 * Built as a combobox rather than a div that happens to hold links, because a
 * search box with a list under it is a control people already know how to use -
 * arrows move, Enter opens, Escape closes - and a screen reader needs to be
 * told the list is there at all.
 */

interface Suggestion {
  slug: string;
  title: string;
  titleAr: string | null;
  price: string;
  inStock: boolean;
  image: string | null;
}

/** Long enough that a fast typist makes one request per word, not per letter. */
const DEBOUNCE_MS = 160;
const MIN_CHARS = 2;

for (const form of document.querySelectorAll<HTMLFormElement>('form[data-suggest]')) {
  const input = form.querySelector<HTMLInputElement>('input[name="q"]');
  if (!input) continue;
  wire(form, input);
}

function wire(form: HTMLFormElement, input: HTMLInputElement): void {
  /*
   * The panel is created here rather than rendered on the server: with
   * JavaScript off it would be an empty box under the search field for ever,
   * and the markup is this file's business, not the page's.
   */
  const panel = document.createElement('div');
  panel.className = 'search-suggest';
  panel.hidden = true;

  const list = document.createElement('ul');
  list.id = `suggest-${Math.random().toString(36).slice(2, 8)}`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Matching titles');
  panel.append(list);

  // Announced politely, so a screen reader hears how many rather than nothing.
  const status = document.createElement('p');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  panel.append(status);

  /*
   * The form is the anchor, not the nearest div.
   *
   * In the hero the field sits inside a pill; in the header it is bare. The
   * form is the one box that is the width of the field in every case - the
   * nearest div in the header is the whole header bar.
   */
  form.style.position = form.style.position || 'relative';
  form.append(panel);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('autocomplete', 'off');

  let items: Suggestion[] = [];
  let active = -1;
  let timer: number | null = null;
  let inFlight: AbortController | null = null;

  /* Backspacing replays queries typed seconds ago; this answers them without
     a request. Capped so a long session cannot grow it without limit. */
  const seen = new Map<string, Suggestion[]>();

  const close = () => {
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const highlight = (next: number) => {
    const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    if (!options.length) return;
    active = (next + options.length) % options.length;
    for (const [i, option] of options.entries()) {
      const on = i === active;
      option.setAttribute('aria-selected', String(on));
      option.classList.toggle('is-active', on);
      if (on) {
        input.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({ block: 'nearest' });
      }
    }
  };

  const draw = (results: Suggestion[], q: string) => {
    items = results;
    list.textContent = '';
    active = -1;
    input.removeAttribute('aria-activedescendant');

    if (!results.length) {
      /*
       * "Nothing here" is worth saying. The shop can often source a title it
       * does not list, so a dead end is the moment to offer that rather than
       * to show an empty box.
       */
      const li = document.createElement('li');
      li.className = 'search-suggest-empty';
      li.textContent = 'No titles match that yet.';
      list.append(li);
      status.textContent = 'No titles match that yet.';
      panel.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      return;
    }

    for (const [i, r] of results.entries()) {
      const li = document.createElement('li');
      li.id = `${list.id}-o${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.className = 'search-suggest-row';

      const link = document.createElement('a');
      link.href = `/book/${r.slug}`;
      link.tabIndex = -1;

      if (r.image) {
        const img = document.createElement('img');
        img.src = r.image;
        img.alt = '';
        img.loading = 'lazy';
        link.append(img);
      } else {
        link.append(document.createElement('span')).className = 'search-suggest-blank';
      }

      const text = document.createElement('span');
      text.className = 'search-suggest-text';

      const title = document.createElement('span');
      title.className = 'search-suggest-title';
      // textContent throughout: these are titles from the database, and the
      // one thing this must never do is hand them to the parser as markup.
      title.textContent = r.title;
      text.append(title);

      if (r.titleAr) {
        const ar = document.createElement('span');
        ar.className = 'search-suggest-ar ar';
        ar.dir = 'rtl';
        ar.textContent = r.titleAr;
        text.append(ar);
      }
      link.append(text);

      const meta = document.createElement('span');
      meta.className = 'search-suggest-meta';
      const cost = document.createElement('span');
      cost.className = 'search-suggest-price';
      cost.textContent = r.price;
      meta.append(cost);
      if (!r.inStock) {
        const out = document.createElement('span');
        out.className = 'search-suggest-out';
        out.textContent = 'Out of stock';
        meta.append(out);
      }
      link.append(meta);

      li.append(link);
      list.append(li);
    }

    status.textContent = `${results.length} ${results.length === 1 ? 'title' : 'titles'} for ${q}`;
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const ask = async (q: string) => {
    const cached = seen.get(q);
    if (cached) {
      draw(cached, q);
      return;
    }

    inFlight?.abort();
    inFlight = new AbortController();
    try {
      const res = await fetch(`/api/search/suggest?q=${encodeURIComponent(q)}`, {
        signal: inFlight.signal,
      });
      const data = (await res.json()) as { q: string; results: Suggestion[] };

      // The box has moved on since this was asked for.
      if (data.q !== input.value.trim()) return;

      if (seen.size > 40) seen.clear();
      seen.set(q, data.results);
      draw(data.results, q);
    } catch {
      /* aborted, offline, or blocked: the form still works, so say nothing */
    }
  };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (timer !== null) clearTimeout(timer);
    if (q.length < MIN_CHARS) {
      close();
      return;
    }
    timer = window.setTimeout(() => ask(q), DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (panel.hidden) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlight(active + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlight(active - 1);
    } else if (event.key === 'Enter' && active > -1 && items[active]) {
      // Only when something is picked. Enter on a plain query still submits
      // the form and lands on the full catalogue results, as it always did.
      event.preventDefault();
      window.location.href = `/book/${items[active].slug}`;
    }
  });

  // Losing focus closes it, but not before a click on a row has landed.
  input.addEventListener('blur', () => window.setTimeout(close, 140));
  input.addEventListener('focus', () => {
    if (input.value.trim().length >= MIN_CHARS && list.childElementCount) {
      panel.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }
  });

  // A submit means they want the whole list, not this shortlist.
  form.addEventListener('submit', close);
}
