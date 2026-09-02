/**
 * The three behaviours that used to live in inline handler attributes.
 *
 * `onchange="this.form.submit()"` and `onsubmit="return confirm(...)"` are
 * inline handlers, and this site's `script-src` carries no `'unsafe-inline'`.
 * The browser refuses them without a word in the page: a select moved and the
 * results never changed, and - worse - a form whose only guard was an inline
 * `confirm()` posted straight through with nothing asked.
 *
 * Wired here instead, from a bundled file that `'self'` already covers. The
 * markup says what it wants in a `data-` attribute and this finds it, so the
 * next control that needs one of these does not have to think about the
 * policy at all.
 */

/**
 * A control that re-submits its own form when its value changes.
 *
 * `requestSubmit()` rather than `submit()`: it fires the form's submit event,
 * so anything else listening - a confirmation, a disabled button - still gets
 * its say. `submit()` skips all of it.
 */
for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
  '[data-autosubmit]',
)) {
  el.addEventListener('change', () => {
    const form = el.form;
    if (!form) return;
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
  });
}

/** A select whose options are URLs, and picking one goes there. */
for (const el of document.querySelectorAll<HTMLSelectElement>('select[data-go]')) {
  el.addEventListener('change', () => {
    if (el.value) window.location.href = el.value;
  });
}

/*
 * Anything destructive enough to ask first.
 *
 * On the form for a whole-form guard, or on the button when one button out of
 * several is the dangerous one. The button case cancels the click, which stops
 * the submit it would have caused - including through `form="..."`, where the
 * button is not inside the form it posts.
 */
for (const form of document.querySelectorAll<HTMLFormElement>('form[data-confirm]')) {
  form.addEventListener('submit', (event) => {
    if (!confirm(form.dataset.confirm ?? 'Are you sure?')) event.preventDefault();
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-confirm]')) {
  button.addEventListener('click', (event) => {
    if (!confirm(button.dataset.confirm ?? 'Are you sure?')) event.preventDefault();
  });
}
