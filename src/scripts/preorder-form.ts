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
