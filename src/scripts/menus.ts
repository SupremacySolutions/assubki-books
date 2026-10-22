/**
 * Disclosure menus that put themselves away.
 *
 * A `<details>` menu opens and closes from its own summary and needs nothing
 * else to work. What it does not do is close when you tap somewhere else, so
 * on a phone the portal's More menu stayed hanging over the page until you
 * found the word that opened it. Escape closes it too, and hands focus back to
 * the summary so the keyboard is not left nowhere.
 */
const menus = document.querySelectorAll<HTMLDetailsElement>('details[data-menu]');

if (menus.length) {
  document.addEventListener('click', (event) => {
    for (const menu of menus) {
      if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const menu of menus) {
      if (!menu.open) continue;
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
  });
}
