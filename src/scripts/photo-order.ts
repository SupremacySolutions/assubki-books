/**
 * Putting the photos in order, the first being the cover.
 *
 * Shared by a listing's photos and a pre-order's: the grid says where its
 * order is saved (`data-order-endpoint`), and this does the rest.
 *
 * Pointer events rather than the browser's own drag and drop, which a phone
 * does not do. A mouse picks a photo up as soon as it moves; a finger has to
 * hold still for a moment first, because a finger that moves straight away is
 * scrolling the page, and taking that from it would trap the owner in the
 * photo grid. The other photos slide aside as it passes, and the order is
 * saved when it is put down - no Save press, no reload, so nothing typed
 * elsewhere on the page is lost.
 *
 * Markup: `<ul data-photo-order data-order-endpoint="…">` holding one
 * `[data-photo-id]` tile per photo, each with an `img`, a `[data-cover-badge]`
 * and a `[data-make-cover]` button. An optional `data-strip="#selector"` names
 * a row of `[data-photo-id]` previews (the channel post's) that follows the
 * order, showing only the first ten - Telegram's album limit.
 */

interface Drag {
  tile: HTMLElement;
  grabX: number;
  grabY: number;
}

interface Pending {
  tile: HTMLElement;
  x: number;
  y: number;
  id: number;
  event: PointerEvent;
  timer?: ReturnType<typeof setTimeout>;
}

export function mountPhotoOrder(grid: HTMLElement): void {
  const endpoint = grid.dataset.orderEndpoint;
  if (!endpoint || grid.children.length < 2) return;
  const orderStatus = document.getElementById(grid.dataset.status ?? 'photoOrderStatus');
  const strip = grid.dataset.strip ? document.querySelector<HTMLElement>(grid.dataset.strip) : null;
  const say = (text: string) => {
    if (orderStatus) orderStatus.textContent = text;
  };

  const tiles = () => [...grid.querySelectorAll<HTMLElement>('[data-photo-id]')];
  const orderOf = () => tiles().map((li) => li.dataset.photoId ?? '');
  let savedOrder = orderOf();
  let savedCover = savedOrder[0];
  let saving = Promise.resolve();
  let dragging: Drag | null = null;
  let pending: Pending | null = null;

  // Badges, labels and the cover's full-bleed crop follow the order.
  const paintOrder = () => {
    const all = tiles();
    all.forEach((li, i) => {
      const badge = li.querySelector<HTMLElement>('[data-cover-badge]');
      const make = li.querySelector<HTMLElement>('[data-make-cover]');
      const img = li.querySelector('img');
      if (badge) badge.hidden = i !== 0;
      if (make) make.hidden = i === 0;
      if (img) img.className = i === 0 ? 'h-full w-full object-cover' : 'max-h-full max-w-full object-contain';
      li.setAttribute('aria-label', `Photo ${i + 1} of ${all.length}${i === 0 ? ', the cover' : ''}`);
    });
    if (strip) {
      const shots = [...strip.querySelectorAll<HTMLElement>('[data-photo-id]')];
      orderOf().forEach((id, i) => {
        const shot = shots.find((s) => s.dataset.photoId === id);
        if (!shot) return;
        shot.hidden = i >= 10;
        strip.appendChild(shot);
      });
    }
  };

  // Puts the tiles back in a given order, for a save that failed.
  const arrange = (ids: string[]) => {
    const byId = new Map(tiles().map((li) => [li.dataset.photoId, li]));
    for (const id of ids) {
      const tile = byId.get(id);
      if (tile) grid.appendChild(tile);
    }
    paintOrder();
  };

  // One save at a time, in the order the moves were made.
  const saveOrder = () => {
    const wanted = orderOf();
    if (wanted.join() === savedOrder.join()) return;
    say('Saving the order…');
    saving = saving.then(async () => {
      const body = new FormData();
      body.append('order', wanted.join(','));
      try {
        const res = await fetch(endpoint, { method: 'POST', body });
        const reply = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(reply.error || 'The order could not be saved.');
        savedOrder = wanted;
        if (orderOf().join() === wanted.join()) {
          say(wanted[0] === savedCover ? 'Order saved.' : 'Order saved, with a new cover.');
          savedCover = wanted[0];
        }
      } catch (err) {
        arrange(savedOrder);
        say(`${err instanceof Error ? err.message : err} Nothing was changed.`);
      }
    });
  };

  // FLIP: note where every tile is, move, then slide each from its old spot to
  // its new one.
  const moveWithSlide = (change: () => void) => {
    const before = new Map(tiles().map((li) => [li, li.getBoundingClientRect()]));
    change();
    for (const [li, was] of before) {
      if (li === dragging?.tile) continue;
      const now = li.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (!dx && !dy) continue;
      li.style.transition = 'none';
      li.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        li.style.transition = 'transform 160ms ease';
        li.style.transform = '';
      });
    }
  };

  // Where a tile sits in the layout, ignoring any slide or drag it is part way
  // through - measuring those made the target flicker.
  const resting = (li: HTMLElement) => {
    const box = grid.getBoundingClientRect();
    return { left: box.left + li.offsetLeft, top: box.top + li.offsetTop, width: li.offsetWidth, height: li.offsetHeight };
  };

  // The tile whose centre is nearest the pointer is where it goes.
  const slotAt = (x: number, y: number) => {
    let best: HTMLElement | null = null;
    let bestDistance = Infinity;
    for (const li of tiles()) {
      const r = resting(li);
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (d < bestDistance) {
        best = li;
        bestDistance = d;
      }
    }
    return best;
  };

  const lift = (tile: HTMLElement, event: PointerEvent) => {
    const home = resting(tile);
    dragging = { tile, grabX: event.clientX - home.left, grabY: event.clientY - home.top };
    tile.style.transition = 'none';
    tile.style.zIndex = '20';
    tile.style.cursor = 'grabbing';
    tile.style.boxShadow = '0 10px 24px rgb(16 24 40 / 0.22)';
    if (navigator.vibrate) navigator.vibrate(10);
  };

  const follow = (event: PointerEvent) => {
    if (!dragging) return;
    const { tile, grabX, grabY } = dragging;
    const target = slotAt(event.clientX, event.clientY);
    if (target && target !== tile) {
      const all = tiles();
      const forward = all.indexOf(target) > all.indexOf(tile);
      moveWithSlide(() => grid.insertBefore(tile, forward ? target.nextSibling : target));
      // The Cover badge moves as it goes, so the owner sees which photo will
      // be the cover before letting go.
      paintOrder();
    }
    const home = resting(tile);
    tile.style.transform = `translate(${event.clientX - grabX - home.left}px, ${event.clientY - grabY - home.top}px) scale(1.04)`;
  };

  const drop = () => {
    if (!dragging) return;
    const { tile } = dragging;
    tile.style.transition = 'transform 160ms ease, box-shadow 160ms ease';
    tile.style.transform = '';
    tile.style.boxShadow = '';
    tile.style.cursor = '';
    setTimeout(() => {
      tile.style.zIndex = '';
      tile.style.transition = '';
    }, 170);
    dragging = null;
    paintOrder();
    saveOrder();
  };

  grid.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    const tile = target.closest<HTMLElement>('[data-photo-id]');
    if (!tile || target.closest('button') || event.button > 0 || dragging) return;
    const held: Pending = { tile, x: event.clientX, y: event.clientY, id: event.pointerId, event };
    pending = held;
    if (event.pointerType === 'mouse') return;
    // A finger: held still for a moment means "pick this up".
    held.timer = setTimeout(() => {
      if (pending !== held) return;
      lift(held.tile, held.event);
      try {
        grid.setPointerCapture(held.id);
      } catch {
        /* The pointer may already be gone. */
      }
      pending = null;
    }, 220);
  });

  grid.addEventListener('pointermove', (event) => {
    if (dragging) {
      event.preventDefault();
      follow(event);
      return;
    }
    if (!pending || event.pointerId !== pending.id) return;
    const moved = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
    if (pending.event.pointerType === 'mouse') {
      if (moved < 5) return;
      lift(pending.tile, pending.event);
      try {
        grid.setPointerCapture(event.pointerId);
      } catch {
        /* As above. */
      }
      pending = null;
      follow(event);
    } else if (moved > 8) {
      // The finger moved before the hold: it is scrolling.
      clearTimeout(pending.timer);
      pending = null;
    }
  });

  const release = () => {
    if (pending) {
      clearTimeout(pending.timer);
      pending = null;
    }
    drop();
  };
  grid.addEventListener('pointerup', release);
  grid.addEventListener('pointercancel', release);
  grid.addEventListener('lostpointercapture', () => {
    if (dragging) drop();
  });

  // Once a photo is picked up, the finger moves it rather than the page.
  grid.addEventListener(
    'touchmove',
    (event) => {
      if (dragging || pending) event.preventDefault();
    },
    { passive: false },
  );
  // A long press would otherwise open the phone's image menu.
  grid.addEventListener('contextmenu', (event) => {
    if (dragging || pending) event.preventDefault();
  });

  for (const button of grid.querySelectorAll<HTMLElement>('[data-make-cover]')) {
    button.addEventListener('click', () => {
      const tile = button.closest<HTMLElement>('[data-photo-id]');
      if (!tile) return;
      moveWithSlide(() => grid.insertBefore(tile, grid.firstChild));
      paintOrder();
      saveOrder();
      tile.focus();
    });
  }

  // The keyboard: arrow keys move the focused photo one place.
  const columns = Number(grid.dataset.columns ?? 3);
  grid.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    const tile = target.closest?.<HTMLElement>('[data-photo-id]');
    if (!tile || target !== tile) return;
    const all = tiles();
    const at = all.indexOf(tile);
    const moves: Record<string, number> = {
      ArrowLeft: at - 1,
      ArrowUp: at - columns,
      ArrowRight: at + 1,
      ArrowDown: at + columns,
      Home: 0,
      End: all.length - 1,
    };
    const to = moves[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const clamped = Math.max(0, Math.min(all.length - 1, to));
    if (clamped === at) return;
    moveWithSlide(() => grid.insertBefore(tile, clamped > at ? all[clamped].nextSibling : all[clamped]));
    paintOrder();
    saveOrder();
    tile.focus();
  });
}

for (const grid of document.querySelectorAll<HTMLElement>('[data-photo-order]')) mountPhotoOrder(grid);
