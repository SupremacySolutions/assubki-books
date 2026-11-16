/**
 * Draws the picture a shared shipment link shows, and stores it.
 *
 * A chat app shows a link's picture either as a wide banner or as a square cut
 * from its middle, so everything that says what the shipment is - where it is
 * from, when it lands, how many titles - sits in a stamp in that middle
 * square. The sides carry the rest for the wide view.
 *
 * Drawn here, on a canvas in the owner's browser, because the edge cannot draw
 * at all. The portal page says what the card should show and what the stored
 * one was drawn from; when those differ (a new shipment, a renamed one, a
 * slipped date, rows added) this redraws it and sends it to
 * /api/admin/shipments/<id>/card. Best effort: if anything fails the shop
 * simply goes on sharing its own card.
 */

const W = 1200;
const H = 630;
const NAVY = '#184485';
const BRASS = '#f0d68a';
const WASH = '#dde3ee';
const DISPLAY = 'Spectral, Georgia, serif';
const BODY = '"IBM Plex Sans", system-ui, sans-serif';

interface CardFacts {
  id: string;
  sig: string;
  title: string;
  /** "Arriving mid-November 2026", "Arrived 4 November 2026". */
  when: string;
  items: number;
}

/**
 * "Pakistan Shipment First Batch November 2026" → origin "Pakistan", detail
 * "First Batch". Without the word "shipment" the whole title is the origin.
 */
export function splitTitle(title: string): { origin: string; detail: string } {
  const match = title.match(/^(.*?)\bshipments?\b(.*)$/i);
  if (!match || !match[1].trim()) return { origin: title.trim(), detail: '' };
  const detail = match[2]
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b(\s*\/\s*\w+)?/gi, '')
    .replace(/\b20\d\d\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { origin: match[1].trim(), detail };
}

/** The largest size up to `max` at which `text` fits `width`. */
function fit(ctx: CanvasRenderingContext2D, text: string, weight: string, family: string, max: number, width: number): number {
  for (let size = max; size > 14; size -= 2) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= width) return size;
  }
  return 14;
}

/** Lines no wider than `width`, at most `limit` of them. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, limit: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, limit);
}

export function drawCard(canvas: HTMLCanvasElement, facts: Omit<CardFacts, 'id' | 'sig'>): void {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { origin, detail } = splitTitle(facts.title);
  const arrived = /^arrived/i.test(facts.when);
  const date = facts.when.replace(/^(arriving|arrived|expected)\s+/i, '');

  ctx.fillStyle = NAVY;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  // The stamp: the middle 630px square, which is what a thumbnail keeps.
  const cx = W / 2;
  const cy = H / 2;
  const r = 236;
  ctx.strokeStyle = BRASS;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.45;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.textAlign = 'center';
  ctx.fillStyle = BRASS;
  ctx.font = `600 22px ${BODY}`;
  ctx.letterSpacing = '4px';
  ctx.fillText(arrived ? 'ARRIVED FROM' : 'ARRIVING FROM', cx, cy - 96);
  ctx.letterSpacing = '0px';

  ctx.fillStyle = '#ffffff';
  const originSize = fit(ctx, origin, '600', DISPLAY, 76, 380);
  ctx.font = `600 ${originSize}px ${DISPLAY}`;
  ctx.fillText(origin, cx, cy - 6);

  if (date) {
    ctx.fillStyle = WASH;
    const dateSize = fit(ctx, date, '400', BODY, 32, 360);
    ctx.font = `400 ${dateSize}px ${BODY}`;
    ctx.fillText(date, cx, cy + 46);
  }

  const count = `${facts.items} ${facts.items === 1 ? 'title' : 'titles'}`;
  ctx.font = `500 26px ${BODY}`;
  const pillW = ctx.measureText(count).width + 44;
  const pillH = 48;
  const pillY = cy + 82;
  ctx.fillStyle = BRASS;
  ctx.beginPath();
  ctx.roundRect(cx - pillW / 2, pillY, pillW, pillH, pillH / 2);
  ctx.fill();
  ctx.fillStyle = '#0e2a55';
  ctx.fillText(count, cx, pillY + 33);

  // The sides, for the wide view only.
  ctx.textAlign = 'left';
  ctx.fillStyle = BRASS;
  ctx.font = `600 20px ${BODY}`;
  ctx.letterSpacing = '3px';
  ctx.fillText('SHIPMENT', 64, cy - 20);
  ctx.letterSpacing = '0px';
  if (detail) {
    ctx.fillStyle = WASH;
    ctx.font = `400 26px ${BODY}`;
    wrap(ctx, detail, 210, 3).forEach((line, i) => ctx.fillText(line, 64, cy + 22 + i * 34));
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 30px ${DISPLAY}`;
  ctx.fillText('As-Subkī Books', W - 64, cy - 20);
  ctx.fillStyle = WASH;
  ctx.font = `400 22px ${BODY}`;
  wrap(ctx, arrived ? 'See what came in' : 'Reserve before they land', 220, 2).forEach((line, i) =>
    ctx.fillText(line, W - 64, cy + 20 + i * 30),
  );
}

async function refresh(holder: HTMLElement): Promise<void> {
  const facts: CardFacts = {
    id: holder.dataset.id ?? '',
    sig: holder.dataset.sig ?? '',
    title: holder.dataset.title ?? '',
    when: holder.dataset.when ?? '',
    items: Number(holder.dataset.items ?? 0),
  };
  if (!facts.id || !facts.title || holder.dataset.stored === facts.sig) return;

  // The card is drawn in the shop's faces; a fallback serif would be stored
  // for good, so wait for the real ones.
  try {
    await Promise.all([
      document.fonts.load(`600 76px ${DISPLAY}`, 'As-Subkī'),
      document.fonts.load(`400 32px ${BODY}`),
      document.fonts.load(`500 26px ${BODY}`),
      document.fonts.load(`600 22px ${BODY}`),
    ]);
  } catch {
    return;
  }

  const canvas = document.createElement('canvas');
  drawCard(canvas, facts);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  if (!blob) return;

  const body = new FormData();
  body.append('card', new File([blob], 'card.jpg', { type: 'image/jpeg' }));
  body.append('sig', facts.sig);
  const status = holder.querySelector<HTMLElement>('[data-card-status]');
  try {
    const res = await fetch(`/api/admin/shipments/${facts.id}/card`, { method: 'POST', body });
    if (!res.ok) throw new Error(String(res.status));
    holder.dataset.stored = facts.sig;
    const preview = holder.querySelector<HTMLImageElement>('[data-card-preview]');
    if (preview) {
      preview.src = URL.createObjectURL(blob);
      preview.hidden = false;
    }
    if (status) status.textContent = 'Link picture updated.';
  } catch {
    if (status) status.textContent = 'Could not update the link picture. It will try again next time this page opens.';
  }
}

const holder = document.querySelector<HTMLElement>('[data-shipment-card]');
if (holder) void refresh(holder);
