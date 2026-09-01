import { readGroup } from './group';

/**
 * The Add button on a book card.
 *
 * It lives here rather than on a page because `BookCard` can appear anywhere -
 * it was wired only inside `book/[slug].astro`, so the first page that used
 * `quickAdd` elsewhere rendered buttons that looked exactly like the working
 * ones and did nothing at all.
 *
 * Delegated from the document, so cards rendered after load are covered too.
 *
 * Deliberately thin. The main add button on a book page re-checks live stock
 * and knows about group baskets; duplicating that here would be a second copy
 * of the rule that could drift from the first. So a group member is sent to
 * the book's own page, where that flow lives, and everyone else adds against
 * the count the card was rendered with - which `addChecked` caps, and which
 * checkout re-checks properly before anything is held.
 */
export function wireQuickAdd(): void {
  document.addEventListener('click', (event) => {
    const add = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.quick-add');
    if (!add || add.disabled) return;

    const id = add.dataset.bookId;
    if (!id) return;

    if (readGroup()) {
      window.location.href = `/book/${add.dataset.slug}`;
      return;
    }

    const result = window.asbBasket.addChecked(id, 1, Number(add.dataset.max ?? '1'));
    window.asbBasket.setBadge(window.asbBasket.count());
    add.textContent = result.added > 0 ? 'Added' : 'In basket';
    add.disabled = true;
    add.classList.add('opacity-60');
  });
}
