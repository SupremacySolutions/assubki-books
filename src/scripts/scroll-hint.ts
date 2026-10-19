/**
 * Fades whichever edge of a sideways-scrolling row has more beyond it.
 *
 * The styling lives with `.scroll-hint` in global.css; this only says which
 * edges to fade. Measured on scroll and on resize rather than once, because
 * the row is narrower than its tabs only on some screens, and turning a phone
 * round can change that.
 */
const rows = document.querySelectorAll<HTMLElement>('.scroll-hint');

const measure = (row: HTMLElement) => {
  // A pixel of slack: fractional widths leave scrollLeft a hair short of the end.
  const end = row.scrollWidth - row.clientWidth - 1;
  row.toggleAttribute('data-more-left', row.scrollLeft > 1);
  row.toggleAttribute('data-more-right', row.scrollLeft < end);
};

if (rows.length) {
  const observer = 'ResizeObserver' in window
    ? new ResizeObserver((entries) => {
        for (const entry of entries) measure(entry.target as HTMLElement);
      })
    : null;
  for (const row of rows) {
    measure(row);
    row.addEventListener('scroll', () => measure(row), { passive: true });
    observer?.observe(row);
  }
  // The portal centres the open tab after the fonts load, which scrolls the
  // row without anybody touching it; the listener above already hears that.
  document.fonts?.ready.then(() => rows.forEach(measure));
}
