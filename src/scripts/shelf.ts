/**
 * The drifting shelf of covers in the hero.
 *
 * It used to be a CSS transform on a track inside `overflow: hidden`: pretty,
 * but nothing in it could be clicked, nothing could be swiped, and it paused
 * only for a desktop mouse hovering it. Someone who spotted a book had to wait
 * for it to come round again, on a ninety-second loop.
 *
 * So the strip is a real scroll container now and this nudges `scrollLeft`
 * along. Native swiping, flicking and trackpad scrolling all keep working, and
 * the drift gets out of the way the moment anyone touches it.
 */

const SPEED = 14; // px per second - the covers should drift, not travel
const RESUME_AFTER = 2500; // ms of being left alone

/**
 * Where the strip should sit after `elapsed` ms of drifting.
 *
 * Pulled out as a plain function because the loop it lives in cannot be
 * exercised in a headless browser - requestAnimationFrame does not run while
 * the tab reports itself hidden - and the wrap is the part worth being sure of:
 * off by one duplicate width and the covers visibly jump.
 */
export function nextOffset(current: number, elapsed: number, half: number): number {
  const moved = current + (SPEED * elapsed) / 1000;
  if (half <= 0) return moved;
  return moved >= half ? moved - half : moved;
}

function start(strip: HTMLElement): void {
  const track = strip.querySelector<HTMLElement>('.shelf-track');
  if (!track) return;

  // The covers are laid out twice, so wrapping at the halfway point is
  // invisible. Measured lazily: the images may not have loaded yet.
  const half = () => track.scrollWidth / 2;

  let held = 0; // >0 while someone is interacting, or a timer is counting down
  let last = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;

  const pause = () => {
    held++;
    if (idle) clearTimeout(idle);
  };

  const release = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      held = 0;
      last = 0; // do not lurch forward by however long they lingered
    }, RESUME_AFTER);
  };

  const step = (now: number) => {
    requestAnimationFrame(step);

    if (held > 0 || document.visibilityState !== 'visible') {
      last = now;
      return;
    }
    if (!last) {
      last = now;
      return;
    }

    const elapsed = now - last;
    last = now;
    strip.scrollLeft = nextOffset(strip.scrollLeft, elapsed, half());
  };

  // Hovering, touching, dragging the scrollbar, or tabbing into a cover all
  // mean someone is reading it rather than watching it go by.
  for (const event of ['pointerenter', 'pointerdown', 'focusin'] as const) {
    strip.addEventListener(event, () => {
      pause();
      held = 1; // one holder, however many of these fired
      release();
    });
  }
  strip.addEventListener('scroll', () => {
    // Their own scrolling, not ours: ours never fires this while paused.
    if (held > 0) release();
  });
  strip.addEventListener('pointerleave', release);

  requestAnimationFrame(step);
}

// Guarded so the maths above can be imported and checked outside a browser.
if (typeof document !== 'undefined') {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const strip of document.querySelectorAll<HTMLElement>('[data-shelf]')) {
    // Under reduced motion the strip stays put, but it is still a scroll
    // container - so every cover remains reachable, which is more than the old
    // frozen track managed.
    if (!reduced) start(strip);
  }
}
