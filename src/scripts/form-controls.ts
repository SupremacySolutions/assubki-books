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
for (const el of document.querySelectorAll<HTMLElement>(
  '[data-autosubmit]',
)) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) continue;
  el.addEventListener('change', () => {
    const form = el.form;
    if (!form) return;
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
  });
}

/** A select whose options are URLs, and picking one goes there. */
for (const el of document.querySelectorAll<HTMLElement>('select[data-go]')) {
  if (!(el instanceof HTMLSelectElement)) continue;
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

/*
 * A posted form's button goes quiet until the next page arrives.
 *
 * On a slow phone connection nothing on the page moved after "Confirm and
 * send" was pressed, so it got pressed again - and a second post of most of
 * these forms is a second message to the customer. The button is marked busy
 * (styled in global.css) for as long as the browser is away.
 *
 * Listened for on the document, so it hears the event after the form's own
 * handlers and the confirmations above: a submit somebody cancelled, or one a
 * script took over with fetch, is left alone. It clears itself after a few
 * seconds in case the response never replaces the page - a download, say - and
 * again when the page is restored from the back/forward cache, where it would
 * otherwise come back still greyed out.
 */
const busy = new Set<HTMLElement>();
document.addEventListener('submit', (event) => {
  if (event.defaultPrevented) return;
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== 'post') return;
  if (form.target && form.target !== '_self') return;
  const button = (event as SubmitEvent).submitter;
  if (!(button instanceof HTMLElement) || !button.classList.contains('btn')) return;
  button.setAttribute('aria-busy', 'true');
  busy.add(button);
  window.setTimeout(() => {
    button.removeAttribute('aria-busy');
    busy.delete(button);
  }, 8000);
});
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  for (const button of busy) button.removeAttribute('aria-busy');
  busy.clear();
});

/*
 * A text box grows to show what is already in it.
 *
 * The payment wording on Settings, a book's description, a shipment's note:
 * each opened at a fixed number of rows, and on a phone the last lines of the
 * owner's own text sat below the box's edge with nothing to say they were
 * there. Grows only - never shrinks under the height the markup gave it, and
 * never taller than most of the screen, after which it scrolls as before.
 *
 * Fitted at load, and a box that is not laid out yet - in a tab or a closed
 * disclosure, where it measures nothing - is fitted when it first appears.
 */
const fitText = (box: HTMLTextAreaElement) => {
  if (box.getClientRects().length === 0) return;
  const cap = Math.round(window.innerHeight * 0.6);
  if (box.scrollHeight <= box.clientHeight || box.offsetHeight >= cap) return;
  const style = getComputedStyle(box);
  const edges = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  box.style.height = `${Math.min(box.scrollHeight + edges, cap)}px`;
};
const boxes = document.querySelectorAll<HTMLTextAreaElement>('textarea.field:not([data-no-grow])');
const firstSight =
  'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          fitText(entry.target as HTMLTextAreaElement);
          firstSight?.unobserve(entry.target);
        }
      })
    : null;
for (const box of boxes) {
  if (box.getClientRects().length > 0 || !firstSight) fitText(box);
  else firstSight.observe(box);
  box.addEventListener('input', () => fitText(box));
}
