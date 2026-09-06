/**
 * The behaviour of the customer-details form, shared by both checkouts.
 *
 * Its partner is `src/components/CheckoutFields.astro`, which renders the
 * markup this speaks to: every id and `data-` hook below is defined there, and
 * the two files change together. What is deliberately *not* here is anything
 * about what is being bought - the basket, the summary, the postage, the
 * request that is finally sent. An ordinary order and a reservation differ in
 * all of those and in none of these.
 *
 * Lifted whole out of `checkout.astro` rather than rewritten, so moving it
 * could not quietly change how the shop's main form behaves.
 */

import { checkOrder, type Field } from '../lib/validate.ts';
import { addressLabels, postcodeRequired, formatAddress, COUNTRIES } from '../lib/address.ts';
import { lookupPostcode, tidyPostcode, looksLikePostcode } from '../lib/postcode-lookup.ts';

/** Every field an error can be shown against. */
const FIELDS = ['name', 'email', 'phone', 'line1', 'city', 'region', 'postcode', 'country'];

/*
 * `fulfilment` and `paymentPreference` are radio groups with no input of their
 * own, so without a slot of their own a problem on either would be marked
 * nowhere and scrolled nowhere.
 */
const ERROR_SLOTS = [...FIELDS, 'fulfilment', 'paymentPreference'];

/** Which problems belong to which step, so a step only gates on its own. */
const STEP_FIELDS: Record<number, string[]> = {
  1: ['name', 'email', 'phone'],
  2: ['fulfilment', 'line1', 'city', 'region', 'postcode', 'country'],
  3: ['paymentPreference'],
};

const LAST = 3;

export interface CheckoutForm {
  /** The form read as the API will receive it. */
  currentValues: () => ReturnType<typeof valuesOf>;
  /** Mark every problem at once and focus the first. True when there were none. */
  showProblems: (problems: { field: Field; message: string }[]) => boolean;
  /** The whole-form error box at the foot of the last step. */
  showError: (message: string) => void;
  /** Move to a step, painting the dots and the recap. */
  goto: (n: number) => void;
  /** Which step a field lives on, for sending someone back to fix it. */
  stepHolding: (field: string) => number;
}

function valuesOf(form: HTMLFormElement) {
  const data = new FormData(form);
  const value = (k: string) => String(data.get(k) ?? '').trim();
  return {
    name: value('name'),
    email: value('email'),
    phone: value('phone'),
    fulfilment: value('fulfilment'),
    paymentPreference: value('paymentPreference'),
    notes: value('notes'),
    address: {
      line1: value('line1'),
      line2: value('line2'),
      city: value('city'),
      region: value('region'),
      postcode: value('postcode'),
      country: value('country'),
    },
  };
}

export function wireCheckoutForm(
  form: HTMLFormElement,
  opts: {
    /**
     * Called with the validated values when the customer sends the form.
     *
     * Everything above has already passed, and the submit button is the
     * caller's to re-enable if it refuses.
     */
    onSubmit: (values: ReturnType<typeof valuesOf>) => void | Promise<void>;
  },
): CheckoutForm {
  const errorBox = document.querySelector<HTMLElement>('#error')!;
  const submit = document.querySelector<HTMLButtonElement>('#submit')!;

  // ------------------------------------------------------------------
  // Field-level errors
  // ------------------------------------------------------------------

  /*
   * Every field an error can point at is an `<input>` - the country is a
   * combobox over one, not a `<select>` - so this is typed as such rather
   * than as a union `querySelector` cannot be given.
   */
  const fieldEl = (name: string) => document.querySelector<HTMLInputElement>(`#${name}`);
  const errorEl = (name: string) =>
    document.querySelector<HTMLElement>(`[data-error-for="${name}"]`);

  function markField(name: string, message: string | null) {
    const input = fieldEl(name);
    const slot = errorEl(name);
    if (slot) {
      slot.textContent = message ?? '';
      slot.hidden = !message;
    }
    if (input) {
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  const clearFields = () => ERROR_SLOTS.forEach((f) => markField(f, null));
  const currentValues = () => valuesOf(form);

  /**
   * Mark everything wrong at once and put the cursor in the first.
   *
   * Being told about one missing field at a time, submit after submit, is how
   * a checkout gets abandoned.
   */
  function showProblems(problems: { field: Field; message: string }[]): boolean {
    clearFields();
    for (const p of problems) markField(p.field, p.message);
    const first = problems[0] && fieldEl(problems[0].field);
    if (first) {
      first.focus();
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    return problems.length === 0;
  }

  function showError(message: string) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /**
   * What the fields are called where they live, and whether a postcode
   * exists there at all - Hong Kong and the Emirates have none, and a
   * required box with no possible answer ends the order.
   */
  function paintCountry() {
    const country = String(new FormData(form).get('country') ?? 'GB');
    const labels = addressLabels(country);
    const optional = ' <span class="text-[var(--color-ink-faint)]">(optional)</span>';

    const set = (name: keyof typeof labels, extra = '') => {
      const label = document.querySelector<HTMLElement>(`[data-label="${name}"]`);
      if (label) label.innerHTML = labels[name] + extra;
    };
    set('city');
    set('region', optional);
    set('postcode');

    const wrap = document.querySelector<HTMLElement>('#postcodeWrap');
    const needed = postcodeRequired(country);
    if (wrap) wrap.hidden = !needed;
    if (!needed) markField('postcode', null);
  }

  // The address only applies to delivery, so it is removed rather than greyed
  // out when collecting - and its errors go with it, or a hidden field would
  // be blocking a collection order for a postcode nobody can see.
  const addressWrap = document.querySelector<HTMLElement>('#addressWrap')!;
  for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="fulfilment"]')) {
    radio.addEventListener('change', () => {
      const delivery =
        form.querySelector<HTMLInputElement>('input[name="fulfilment"]:checked')?.value === 'delivery';
      addressWrap.hidden = !delivery;
      if (!delivery) ['line1', 'city', 'region', 'postcode', 'country'].forEach((f) => markField(f, null));
    });
  }

  paintCountry();

  // Checked as they leave a field, not as they type it: telling someone their
  // email is wrong while they are still typing it is nagging, not helping.
  for (const name of FIELDS) {
    fieldEl(name)?.addEventListener('blur', () => {
      const problems = checkOrder(currentValues()).filter((p) => p.field === name);
      markField(name, problems[0]?.message ?? null);
    });
  }

  // ------------------------------------------------------------------
  // Country: a box you can type into
  // ------------------------------------------------------------------

  const countryInput = document.querySelector<HTMLInputElement>('#country')!;
  const countryCode = document.querySelector<HTMLInputElement>('#countryCode')!;
  const countryList = document.querySelector<HTMLUListElement>('#countryList')!;
  let active = -1;

  const nameForCode = (code: string) => COUNTRIES.find((c) => c.code === code)?.name ?? '';

  function closeList() {
    countryList.hidden = true;
    countryInput.setAttribute('aria-expanded', 'false');
    active = -1;
  }

  /* Matched on the name *and* the code, so "GB", "UK" and "United" all find
     the United Kingdom. Anything already typed that is not a country is
     thrown away on blur rather than left looking accepted. */
  function openList(query: string) {
    const q = query.trim().toLowerCase();
    const matches = COUNTRIES.filter(
      (c) => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q ||
        (q === 'uk' && c.code === 'GB'),
    ).slice(0, 40);

    countryList.innerHTML = '';
    for (const [i, c] of matches.entries()) {
      const li = document.createElement('li');
      li.id = `country-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(c.code === countryCode.value));
      li.dataset.code = c.code;
      li.className =
        'px-3 py-2 text-[14.5px] cursor-pointer hover:bg-[var(--color-paper)] aria-selected:font-medium';
      li.textContent = c.name;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // before blur, or the pick is lost
        choose(c.code);
      });
      countryList.appendChild(li);
    }
    countryList.hidden = matches.length === 0;
    countryInput.setAttribute('aria-expanded', String(!countryList.hidden));
    active = -1;
  }

  function choose(code: string) {
    countryCode.value = code;
    countryInput.value = nameForCode(code);
    closeList();
    markField('country', null);
    paintCountry();
    maybeLookUpPostcode();
  }

  function highlight(delta: number) {
    const items = [...countryList.querySelectorAll<HTMLLIElement>('[role="option"]')];
    if (!items.length) return;
    items[active]?.classList.remove('bg-[var(--color-paper)]');
    active = (active + delta + items.length) % items.length;
    items[active].classList.add('bg-[var(--color-paper)]');
    items[active].scrollIntoView({ block: 'nearest' });
    countryInput.setAttribute('aria-activedescendant', items[active].id);
  }

  countryInput.value = nameForCode(countryCode.value);
  countryInput.addEventListener('input', () => openList(countryInput.value));
  countryInput.addEventListener('focus', () => openList(''));
  countryInput.addEventListener('blur', () => {
    // Put back the chosen country's name: a half-typed "Unit" left in the box
    // reads as an accepted answer when it is not.
    countryInput.value = nameForCode(countryCode.value);
    closeList();
  });
  countryInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); if (countryList.hidden) openList(countryInput.value); else highlight(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); highlight(-1); }
    else if (event.key === 'Enter') {
      const items = [...countryList.querySelectorAll<HTMLLIElement>('[role="option"]')];
      const pick = items[active] ?? (items.length === 1 ? items[0] : null);
      if (pick) { event.preventDefault(); choose(pick.dataset.code!); }
    } else if (event.key === 'Escape') closeList();
  });

  // ------------------------------------------------------------------
  // Postcode: tidy it, and fill in the town
  // ------------------------------------------------------------------

  const postcodeEl = document.querySelector<HTMLInputElement>('#postcode')!;
  const cityEl = document.querySelector<HTMLInputElement>('#city')!;
  const regionEl = document.querySelector<HTMLInputElement>('#region')!;
  const postcodeHint = document.querySelector<HTMLElement>('#postcode-hint')!;
  let lookupRun: AbortController | null = null;
  let lookupTimer = 0;

  /*
   * A convenience and nothing more. It never blocks, never complains, and
   * never writes over something the customer typed themselves - filling in a
   * town on top of the one they chose is worse than filling in nothing.
   */
  async function maybeLookUpPostcode() {
    lookupRun?.abort();
    postcodeHint.textContent = '';
    if (countryCode.value !== 'GB') return;

    const raw = postcodeEl.value;
    if (!looksLikePostcode(raw)) return;
    if (cityEl.value.trim() && regionEl.value.trim()) return;

    const run = new AbortController();
    lookupRun = run;
    const place = await lookupPostcode(raw, run.signal);
    if (run.signal.aborted || !place) return;

    postcodeEl.value = place.postcode;
    let filled = false;
    if (!cityEl.value.trim() && place.city) { cityEl.value = place.city; filled = true; }
    if (!regionEl.value.trim() && place.region) { regionEl.value = place.region; filled = true; }
    if (filled) {
      postcodeHint.textContent = `Found ${[place.city, place.region].filter(Boolean).join(', ')}.`;
      markField('city', null);
    }
  }

  postcodeEl.addEventListener('input', () => {
    clearTimeout(lookupTimer);
    lookupTimer = window.setTimeout(maybeLookUpPostcode, 400);
  });
  postcodeEl.addEventListener('blur', () => {
    // Tidying needs no network: m14wb is M1 4WB whatever the API says.
    if (postcodeEl.value.trim()) postcodeEl.value = tidyPostcode(postcodeEl.value);
  });

  // ------------------------------------------------------------------
  // Three steps
  // ------------------------------------------------------------------

  const sections = [...form.querySelectorAll<HTMLElement>('[data-step]')];
  const backBtn = document.querySelector<HTMLButtonElement>('#back')!;
  const nextBtn = document.querySelector<HTMLButtonElement>('#next')!;
  const aside = document.querySelector<HTMLElement>('#aside')!;
  let step = 1;

  const stepHolding = (field: string) =>
    Number(Object.entries(STEP_FIELDS).find(([, f]) => f.includes(field))?.[0] ?? LAST);

  function paintSteps() {
    for (const section of sections) section.hidden = Number(section.dataset.step) !== step;

    for (const dot of document.querySelectorAll<HTMLElement>('[data-dot]')) {
      const n = Number(dot.dataset.dot);
      const mark = dot.querySelector<HTMLElement>('[data-dot-mark]')!;
      const done = n < step;
      const here = n === step;
      mark.className =
        'grid place-items-center w-[22px] h-[22px] rounded-full border text-[12px] font-semibold tabular-nums ' +
        (here
          ? 'bg-[var(--color-navy)] border-[var(--color-navy)] text-white'
          : done
            ? 'bg-white border-[var(--color-navy)] text-[var(--color-navy)]'
            : 'bg-white border-[var(--color-rule)] text-[var(--color-ink-faint)]');
      mark.textContent = done ? '✓' : String(n);
      dot.querySelector<HTMLElement>('[data-dot-label]')!.className =
        'hidden sm:inline ' + (here ? 'font-medium' : 'text-[var(--color-ink-faint)]');
    }

    backBtn.hidden = step === 1;
    nextBtn.hidden = step === LAST;
    submit.hidden = step !== LAST;

    // On a phone the basket belongs on the last step, where they are checking
    // it. On a desktop there is a column for it and it stays put throughout.
    aside.classList.toggle('max-md:hidden', step !== LAST);
  }

  function goto(n: number) {
    step = Math.min(LAST, Math.max(1, n));
    paintSteps();
    if (step === LAST) paintRecap();
    form.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const first = sections
      .find((s) => Number(s.dataset.step) === step)
      ?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea');
    if (step !== LAST) first?.focus({ preventScroll: true });
  }

  /** What they typed, read back before they send it. */
  function paintRecap() {
    const v = currentValues();
    document.querySelector<HTMLElement>('#recapWho')!.textContent =
      [v.name, v.email, v.phone].filter(Boolean).join(' · ');

    const pay = v.paymentPreference === 'cash'
      ? 'Cash in person'
      : v.paymentPreference === 'transfer' ? 'Bank transfer' : '';
    const how = v.fulfilment === 'collection'
      ? 'Collecting in person'
      : `Posted to:\n${formatAddress(v.address)}`;
    document.querySelector<HTMLElement>('#recapHow')!.innerHTML =
      [how, pay].filter(Boolean).join('\n').split('\n')
        .map((l) => l.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]!))
        .join('<br />');
  }

  backBtn.addEventListener('click', () => goto(step - 1));
  nextBtn.addEventListener('click', () => {
    const mine = new Set(STEP_FIELDS[step]);
    const problems = checkOrder(currentValues()).filter((p) => mine.has(p.field));
    if (!showProblems(problems)) return;
    goto(step + 1);
  });
  for (const jump of document.querySelectorAll<HTMLButtonElement>('[data-goto]')) {
    jump.addEventListener('click', () => goto(Number(jump.dataset.goto)));
  }
  paintSteps();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    // The page checks first so the customer is not made to wait on a round
    // trip to be told their postcode is missing. The server checks again,
    // and it is the one that decides.
    const problems = checkOrder(currentValues());
    if (problems.length) {
      showProblems(problems);
      goto(stepHolding(problems[0].field));
      return;
    }

    await opts.onSubmit(currentValues());
  });

  return { currentValues, showProblems, showError, goto, stepHolding };
}
