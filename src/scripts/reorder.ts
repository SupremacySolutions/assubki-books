import { addChecked } from './basket.ts';

/**
 * Fills the basket from a past order.
 *
 * Syllabus sets get bought once a year by the same madrasah for the next
 * intake, and retyping eleven titles is the reason that does not happen on the
 * site.
 *
 * It fills the basket and stops there - it does not place an order. Everything
 * is resolved against today's catalogue rather than the order's own snapshot,
 * so a year-old order cannot carry a year-old price forward, and a title that
 * has since gone is reported rather than quietly dropped.
 */
const button = document.querySelector<HTMLButtonElement>('[data-reorder]');
const said = document.querySelector<HTMLElement>('[data-reorder-said]');

if (button) {
  button.addEventListener('click', async () => {
    let wanted: { slug: string; qty: number }[];
    try {
      wanted = JSON.parse(button.dataset.reorder ?? '[]');
    } catch {
      return;
    }
    if (!wanted.length) return;

    const tell = (text: string) => {
      if (!said) return;
      said.textContent = text;
      said.hidden = false;
    };

    button.disabled = true;
    try {
      const res = await fetch('/api/basket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slugs: wanted.map((w) => w.slug) }),
      });
      const { books } = (await res.json()) as {
        books: { id: number; slug: string; title: string; available: number }[];
      };

      const bySlug = new Map(books.map((b) => [b.slug, b]));
      let added = 0;
      let short = 0;
      let gone = 0;

      for (const line of wanted) {
        const book = bySlug.get(line.slug);
        if (!book) {
          gone++;
          continue;
        }
        // The same clamp the book page uses, so two routes into the basket
        // cannot disagree about how many copies exist.
        const result = addChecked(book.id, line.qty, book.available);
        if (result.added > 0) added++;
        if (result.capped) short++;
      }

      if (!added) {
        tell('None of these are available at the moment.');
        return;
      }

      const parts = [`${added} ${added === 1 ? 'title' : 'titles'} added to your basket`];
      if (short) parts.push(`${short} in smaller numbers than last time`);
      if (gone) parts.push(`${gone} no longer listed`);
      tell(`${parts.join(' · ')}.`);
    } catch {
      tell('That did not work. Please try again.');
    } finally {
      button.disabled = false;
    }
  });
}
