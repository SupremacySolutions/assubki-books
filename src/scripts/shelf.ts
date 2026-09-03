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
/**
 * How long to wait before drifting again after someone *scrolled* it.
 *
 * Only for scrolling and touching. A mouse leaving the strip resumes at once -
 * waiting two and a half seconds after the cursor has gone reads as broken,
 * because by then there is nothing on screen to explain why it is still.
 */
const RESUME_AFTER = 2500;

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

/**
 * Keeps the drift's own idea of where the strip is, as a float.
 *
 * **The strip cannot be asked where it is.** A browser rounds `scrollLeft` to
 * whole pixels on read, and a drift this slow moves about a quarter of a pixel
 * per frame - so reading the value back and adding to it rounded every frame's
 * movement away, and the covers sat perfectly still. The remainder has to live
 * here, in a number the browser cannot round.
 */
export function createDrift(el: { scrollLeft: number }, halfWidth: () => number) {
  let pos = el.scrollLeft;
  /** What we last wrote, so a change we did not make can be recognised. */
  let wrote = el.scrollLeft;

  return {
    step(elapsed: number): void {
      /*
       * Anything that moved the strip since our last write wins.
       *
       * A phone's momentum keeps running after the finger has gone, and the
       * browser scrolls a focused cover into view on its own. Both change
       * `scrollLeft` without a resync, and without this the next frame wrote a
       * position from before it happened - yanking the strip back mid-flick,
       * which is what a swipe on a phone actually felt like.
       */
      if (Math.abs(el.scrollLeft - wrote) > 1) pos = el.scrollLeft;

      pos = nextOffset(pos, elapsed, halfWidth());
      el.scrollLeft = pos;
      // Read back rather than trusting `pos`: the browser rounds on write as
      // well as on read, and comparing a float to a rounded value would make
      // every frame look like somebody else's scroll.
      wrote = el.scrollLeft;
    },
    /** They scrolled it themselves; carry on from wherever they left it. */
    resync(): void {
      pos = el.scrollLeft;
      wrote = el.scrollLeft;
    },
    /** Whether the strip has moved since we last wrote to it. */
    moved(): boolean {
      return Math.abs(el.scrollLeft - wrote) > 1;
    },
  };
}

/**
 * Who currently has the strip, and when it may drift again.
 *
 * Pulled out of the listeners for the same reason `nextOffset` was: none of it
 * can be exercised in a headless browser, and the rule it encodes is easy to
 * get wrong. It was wrong - a mouse leaving the strip armed the same 2500ms
 * timer as a thumb mid-flick, so the covers sat still for two and a half
 * seconds after the cursor had gone, with nothing on screen to explain why.
 *
 * The two cases are genuinely different. A cursor leaving means nobody is
 * reading it: carry on at once. A finger that has just scrolled means someone
 * still is, and drifting into their scroll would fight it: wait.
 */
export function createHold(opts: {
  resumeAfter: number;
  hasFocus: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
}) {
  let held = false;
  let hovering = false;
  let idle: unknown = null;

  const cancel = () => {
    if (idle !== null) opts.clearTimer(idle);
    idle = null;
  };

  /**
   * Now - unless a cursor is still on it, or a cover still has focus.
   *
   * A blocked resume **asks again** rather than giving up. It used to return
   * here having already cancelled its own timer, so nothing was left to try
   * later: tapping a cover on a phone focuses it, and a phone often never
   * fires `focusout` afterwards, so the shelf froze on the first tap and
   * stayed frozen for the life of the page.
   */
  const resume = () => {
    cancel();
    if (hovering) return; // a cursor leaving fires `pointerleave`, which retries
    if (opts.hasFocus()) {
      idle = opts.setTimer(resume, opts.resumeAfter);
      return;
    }
    held = false;
  };

  return {
    held: () => held,
    /** `mouse` is the only pointer type that can go on hovering afterwards. */
    grab(pointerType?: string) {
      if (pointerType === 'mouse') hovering = true;
      cancel();
      held = true;
    },
    /** The cursor or the keyboard has gone. */
    leave() {
      hovering = false;
      resume();
    },
    /** They scrolled or lifted a finger: let them finish first. */
    soon() {
      cancel();
      idle = opts.setTimer(resume, opts.resumeAfter);
    },
  };
}

function start(strip: HTMLElement): void {
  const track = strip.querySelector<HTMLElement>('.shelf-track');
  if (!track) return;

  // The covers are laid out twice, so wrapping at the halfway point is
  // invisible. Measured lazily: the images may not have loaded yet.
  const half = () => track.scrollWidth / 2;
  const drift = createDrift(strip, half);

  const hold = createHold({
    resumeAfter: RESUME_AFTER,
    hasFocus: () => strip.contains(document.activeElement),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  });

  let last = 0;

  const step = (now: number) => {
    requestAnimationFrame(step);

    if (hold.held() || document.visibilityState !== 'visible') {
      last = now;
      return;
    }
    if (!last) {
      last = now; // do not lurch forward by however long they lingered
      return;
    }

    const elapsed = now - last;
    last = now;
    drift.step(elapsed);
  };

  // Hovering, touching, dragging the scrollbar, or tabbing into a cover all
  // mean someone is reading it rather than watching it go by.
  for (const event of ['pointerenter', 'pointerdown', 'focusin'] as const) {
    strip.addEventListener(event, (e) => {
      hold.grab(e instanceof PointerEvent ? e.pointerType : undefined);
    });
  }

  /*
   * Their scrolling, not ours.
   *
   * The `held` check alone was not enough. A flick's momentum outlives the
   * finger, and once the hold has lapsed those scrolls arrived with `held`
   * false and were ignored - so the drift went on writing a position from
   * before the flick. Asking the drift whether the strip moved without it
   * catches that, and catches the browser scrolling a focused cover into view
   * as well.
   */
  strip.addEventListener('scroll', () => {
    if (!hold.held() && !drift.moved()) return; // our own write, echoed back
    drift.resync();
    hold.soon();
  });

  // A finger lifting. `pointerleave` is not reliable for touch, so without
  // this a tap that never became a scroll would hold the strip for good.
  for (const event of ['pointerup', 'pointercancel'] as const) {
    strip.addEventListener(event, () => hold.soon());
  }

  strip.addEventListener('pointerleave', () => hold.leave());
  strip.addEventListener('focusout', () => {
    // Tabbing from one cover to the next is not leaving the strip.
    if (!strip.contains(document.activeElement)) hold.leave();
  });

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
