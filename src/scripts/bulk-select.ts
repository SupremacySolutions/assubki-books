/**
 * Choosing listings to act on, and confirming before it happens.
 *
 * Every part of this is an improvement on something that already works without
 * it. The checkboxes tick, the buttons submit and the server still checks the
 * count it was handed against the count it can see, so with JavaScript off the
 * only thing missing is the confirmation - and nothing this form does is
 * irreversible. That is the reason the confirmation may live here at all.
 */

/**
 * Which rows a shift-click should sweep, as indices.
 *
 * Pulled out of the DOM wiring and exported for the same reason `shelf.ts`
 * exports `nextOffset`: the suite cannot click, but it can check the arithmetic,
 * and off-by-one in a range select is the kind of thing that silently misses the
 * last row of a selection of two hundred. Inclusive at both ends, and correct
 * whichever way the user dragged.
 */
export function rangeBetween(anchor: number, index: number): number[] {
  if (anchor < 0 || index < 0) return [];
  const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/**
 * What the toolbar should look like for a given selection.
 *
 * `wide` is the "all N matching" scope, which counts as a selection even though
 * no row is ticked - getting that wrong disables the buttons exactly when the
 * owner has asked for the largest possible action.
 */
export function selectionState(
  checked: number,
  total: number,
  wide: boolean,
): { label: string; disabled: boolean; all: boolean; some: boolean } {
  return {
    label: wide ? '' : checked ? `${checked} selected` : '',
    disabled: !wide && checked === 0,
    all: total > 0 && checked === total,
    some: checked > 0 && checked < total,
  };
}

const form =
  typeof document === 'undefined'
    ? null
    : document.querySelector<HTMLFormElement>('#bulkForm');
const rows = () => [...document.querySelectorAll<HTMLInputElement>('[data-bulk-row]')];

if (form) {
  const master = document.querySelector<HTMLInputElement>('#bulkAll');
  const count = document.querySelector<HTMLOutputElement>('#bulkCount');
  const scope = form.querySelector<HTMLInputElement>('input[name="scope"]');
  const buttons = () => [...form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')];

  const selected = () => rows().filter((r) => r.checked);

  const sync = () => {
    /*
     * With nothing chosen there is nothing to do, so the buttons say so rather
     * than posting an action the server will only refuse. The filter scope is
     * its own kind of "chosen", which is why it counts here.
     */
    const state = selectionState(selected().length, rows().length, scope?.checked ?? false);

    if (count) count.textContent = state.label;
    for (const button of buttons()) button.disabled = state.disabled;
    if (master) {
      master.checked = state.all;
      master.indeterminate = state.some;
    }
  };

  master?.addEventListener('change', () => {
    for (const row of rows()) row.checked = master.checked;
    sync();
  });

  scope?.addEventListener('change', () => {
    /*
     * Describing a set and ticking one are different instructions, and holding
     * both would leave the owner unsure which they gave. Choosing "all matching"
     * clears the ticks; ticking anything clears "all matching".
     */
    if (scope.checked) for (const row of rows()) row.checked = false;
    sync();
  });

  /*
   * Shift-click selects a range, the way every file list does.
   *
   * Without it, "tick these thirty consecutive drafts" is thirty clicks, which
   * is most of the tedium this feature exists to remove.
   */
  let anchor: number | null = null;
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-bulk-row]')) return;

    const all = rows();
    const index = all.indexOf(target);
    if (event.shiftKey && anchor !== null && index !== -1) {
      for (const i of rangeBetween(anchor, index)) all[i].checked = target.checked;
    }
    anchor = index;
    if (target.checked && scope?.checked) scope.checked = false;
    sync();
  });

  /*
   * The confirmation names the action and the number, then submits the button
   * that was actually pressed.
   *
   * A submit button's own name/value only reaches the server when the form is
   * submitted *by that button*, and `form.submit()` sends neither - so the
   * pressed action is carried across by hand rather than lost, which would post
   * a bulk edit with no action at all.
   */
  const dialog = document.querySelector<HTMLDialogElement>('#bulkConfirm');
  const what = document.querySelector<HTMLElement>('#bulkConfirmWhat');
  const confirmButton = document.querySelector<HTMLButtonElement>('#bulkConfirmGo');
  let pending: HTMLButtonElement | null = null;

  if (dialog && confirmButton) {
    for (const button of buttons()) {
      button.addEventListener('click', (event) => {
        if (button.dataset.confirmed === 'yes') return;
        event.preventDefault();
        pending = button;
        const n = scope?.checked
          ? (scope.closest('label')?.textContent ?? 'every matching listing').trim()
          : `${selected().length} listing${selected().length === 1 ? '' : 's'}`;
        if (what) what.textContent = `${button.dataset.bulkVerb ?? 'Change'} — ${n}.`;
        dialog.showModal();
      });
    }

    confirmButton.addEventListener('click', () => {
      dialog.close();
      if (!pending) return;
      pending.dataset.confirmed = 'yes';
      pending.click();
    });
  }

  // A slow bulk edit is still a bulk edit; without this a second click sends
  // the same action twice and the second one has nothing left to change.
  form.addEventListener('submit', () => {
    for (const button of buttons()) button.disabled = true;
  });

  sync();
}
