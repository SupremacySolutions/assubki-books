/**
 * Choosing listings to delete, and confirming before it happens.
 *
 * Every part of this is an improvement on something that already works without
 * it. The checkboxes tick and the button submits, so with JavaScript off the
 * only thing missing is the confirmation. That is allowed to live here because
 * the delete it guards is itself reversible - the listings go to the bin for
 * thirty days and the banner offers an Undo - so a confirmation that never
 * appears costs the owner a trip to Recently deleted, not their catalogue.
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
 * Exported and checked directly for the same reason as `rangeBetween`: the
 * master checkbox has three states rather than two, and "some but not all" is
 * the one that is easy to get wrong and invisible when it is.
 */
export function selectionState(
  checked: number,
  total: number,
): { label: string; disabled: boolean; all: boolean; some: boolean } {
  return {
    label: checked ? `${checked} selected` : '',
    disabled: checked === 0,
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
  const buttons = () => [...form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')];

  const selected = () => rows().filter((r) => r.checked);

  const sync = () => {
    /*
     * With nothing ticked there is nothing to delete, so the button says so
     * rather than posting a selection the server will only refuse.
     */
    const state = selectionState(selected().length, rows().length);

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
    sync();
  });

  /*
   * The confirmation names the number, then lets the press through.
   *
   * It re-clicks the button rather than calling `form.submit()`, which would
   * skip the form's own submit handler and with it the double-post guard below.
   * `data-confirmed` is what stops the second click reopening the dialog.
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
        const n = selected().length;
        if (what) what.textContent = `${n} listing${n === 1 ? '' : 's'} go to the bin.`;
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

  // A slow delete is still a delete; without this a second click sends the same
  // selection twice and the second one has nothing left to bin.
  form.addEventListener('submit', () => {
    for (const button of buttons()) button.disabled = true;
  });

  sync();
}
