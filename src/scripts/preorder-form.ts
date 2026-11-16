/**
 * The pre-order form's cover, sent through the same review as a listing's.
 *
 * Without scripting the form posts the photo as chosen and the server keeps
 * it as the original - `/img` serves that for every size. With scripting the
 * photo is straightened by the owner, framed, and cut into the sized versions
 * first, exactly as the listing editor does, and the form is sent with those
 * in place of the raw file.
 *
 * The seam is `window.coverClean`, set by `mountCoverReview` - see
 * cover-review.ts. If it is missing the form simply submits as normal.
 */

interface CoverClean {
  review(file: File): Promise<File | null>;
  dress(file: File): Promise<{ master: File; width: number; height: number; variants: Map<string, File> }>;
}

export function submitPreorderForm(): void {
  const form = document.querySelector<HTMLFormElement>('#preorderForm');
  const input = form?.querySelector<HTMLInputElement>('#photo');
  const status = document.querySelector<HTMLElement>('#coverStatus');
  const preview = document.querySelector<HTMLImageElement>('#coverPreview');
  if (!form || !input) return;

  /*
   * The file input is visually hidden behind its button, so nothing else says
   * a photo was chosen. Without this the owner presses Upload, picks a file,
   * and the page looks exactly as it did.
   */
  const chosenName = document.querySelector<HTMLElement>('#photoName');
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (chosenName) chosenName.textContent = file ? file.name : '';
    if (file && preview) {
      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
    }
  });

  let sending = false;

  form.addEventListener('submit', async (event) => {
    const chosen = input.files?.[0];
    const clean = (window as unknown as { coverClean?: CoverClean }).coverClean;
    if (!chosen || !clean || sending) return;

    event.preventDefault();
    const original = await clean.review(chosen);
    if (!original) {
      // Cancelled: the owner refused this photo, so it must not be sent.
      input.value = '';
      if (status) status.textContent = 'Cover not added. Choose another photo, or save without one.';
      return;
    }

    sending = true;
    if (status) status.textContent = 'Preparing the cover…';
    const dressed = await clean.dress(original);

    const body = new FormData(form);
    body.delete('photo');
    body.append('photo', dressed.variants.size ? dressed.master : original);
    if (dressed.width && dressed.height) {
      body.append('width', String(dressed.width));
      body.append('height', String(dressed.height));
    }
    for (const [name, variant] of dressed.variants) body.append(`variant:${name}`, variant);

    if (status) status.textContent = 'Saving…';
    try {
      const res = await fetch(form.action, { method: 'POST', body });
      if (!res.ok) throw new Error(await res.text());
      // The save answers with a redirect to the page to show next; fetch has
      // followed it, so go where it went.
      window.location.assign(res.url);
    } catch (err) {
      sending = false;
      if (status) status.textContent = `Could not save. ${err}`;
    }
  });

  // A glance at the chosen photo before it is sent.
  input.addEventListener('change', () => {
    const chosen = input.files?.[0];
    if (!chosen || !preview) return;
    preview.src = URL.createObjectURL(chosen);
    preview.hidden = false;
  });
}

/**
 * A saved pre-order's photos: added several at a time, removed one at a time,
 * each saved as it happens.
 *
 * Every photo goes through the same review and cutting as the cover above -
 * straightened by the owner, then sent with its sized versions - one after
 * another, so a refused photo does not stop the ones after it. The page is
 * reloaded at the end to show them in the grid, where they can be put in
 * order (src/scripts/photo-order.ts).
 */
export function wirePreorderPhotos(): void {
  const input = document.querySelector<HTMLInputElement>('#morePhotos');
  const status = document.querySelector<HTMLElement>('#morePhotosStatus');
  const say = (text: string) => {
    if (status) status.textContent = text;
  };

  input?.addEventListener('change', async () => {
    const endpoint = input.dataset.endpoint;
    const room = Number(input.dataset.room ?? 0);
    const chosen = [...(input.files ?? [])];
    input.value = '';
    if (!endpoint || !chosen.length) return;

    const files = chosen.slice(0, room);
    const clean = (window as unknown as { coverClean?: CoverClean }).coverClean;
    let added = 0;
    const problems: string[] = [];

    for (const [i, file] of files.entries()) {
      say(`Photo ${i + 1} of ${files.length}…`);
      const reviewed = clean ? await clean.review(file) : file;
      if (!reviewed) continue; // Refused in the review: not sent.
      const dressed = clean ? await clean.dress(reviewed) : null;

      const body = new FormData();
      body.append('photo', dressed?.variants.size ? dressed.master : reviewed);
      if (dressed?.width && dressed.height) {
        body.append('width', String(dressed.width));
        body.append('height', String(dressed.height));
      }
      for (const [name, variant] of dressed?.variants ?? []) body.append(`variant:${name}`, variant);

      try {
        const res = await fetch(endpoint, { method: 'POST', body });
        const reply = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(reply.error || `Could not save ${file.name}.`);
        added++;
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }

    if (chosen.length > room) problems.push(`Only ${room} more could be added; the rest were left out.`);
    if (added) {
      say(problems.length ? `${added} added. ${problems.join(' ')} Reloading…` : `${added} added. Reloading…`);
      window.location.reload();
    } else {
      say(problems.join(' ') || 'No photos were added.');
    }
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-remove-photo]')) {
    button.addEventListener('click', async () => {
      const grid = button.closest<HTMLElement>('[data-order-endpoint]');
      const endpoint = grid?.dataset.orderEndpoint?.replace(/\/photos$/, '/photo-delete');
      if (!endpoint || !confirm('Remove this photo?')) return;
      button.disabled = true;
      const body = new FormData();
      body.append('photo', button.dataset.removePhoto ?? '');
      const res = await fetch(endpoint, { method: 'POST', body }).catch(() => null);
      if (res?.ok) {
        window.location.reload();
        return;
      }
      button.disabled = false;
      const reply = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
      const out = document.querySelector<HTMLElement>('#photoOrderStatus');
      if (out) out.textContent = reply?.error ?? 'That photo could not be removed. Try again.';
    });
  }
}
