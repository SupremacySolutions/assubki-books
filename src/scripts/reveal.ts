/**
 * Reveals sections as they scroll into view.
 *
 * An observer rather than a scroll handler, so nothing runs on the main thread
 * between intersections. Elements unobserve once shown: this is an entrance,
 * not something that should replay every time the page scrolls back up.
 */
const items = document.querySelectorAll<HTMLElement>('.reveal');
if (!items.length) {
  // nothing to do
} else if (
  !('IntersectionObserver' in window) ||
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
) {
  // No observer, or motion is unwelcome: show everything immediately.
  for (const el of items) el.classList.add('is-visible');
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    },
    // Fire slightly before the element arrives, so it is already settled by
    // the time it is properly in view.
    { rootMargin: '0px 0px -8% 0px', threshold: 0.06 },
  );

  for (const el of items) observer.observe(el);
}
