const transition = document.querySelector<HTMLElement>('#pageTransition');

if (transition) {
  let internalNavigation = false;
  try {
    internalNavigation = sessionStorage.getItem('asb-internal-navigation') === '1';
    if (internalNavigation) sessionStorage.removeItem('asb-internal-navigation');
  } catch {
    /* Private browsing can disable session storage. */
  }

  if (internalNavigation) transition.classList.remove('is-loading');

  const startedAt = performance.now();
  const hideInitial = () => {
    if (internalNavigation) return;
    const remaining = Math.max(0, 850 - (performance.now() - startedAt));
    window.setTimeout(() => transition.classList.remove('is-loading'), remaining);
  };
  if (document.readyState === 'complete') hideInitial();
  else window.addEventListener('load', hideInitial, { once: true });

  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    link.addEventListener('click', (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) return;
      const target = new URL(link.href, window.location.href);
      if (target.origin !== window.location.origin) return;
      try { sessionStorage.setItem('asb-internal-navigation', '1'); } catch { /* ignore */ }
    });
  }
}