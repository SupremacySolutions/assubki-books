import type { APIRoute } from 'astro';
import { setGroupLine, cleanName, MAX_QTY } from '../../../lib/group';

export const prerender = false;

/** Set one person's quantity for one title. Zero removes their line. */
export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const code = String(body.code ?? '').trim();
  const token = String(body.token ?? '').trim();
  const person = cleanName(body.name);
  const bookId = Number(body.bookId);
  const qty = Number(body.qty);

  if (!code || !token || person.length < 2) {
    return Response.json({ ok: false, error: 'Missing group or name.' }, { status: 400 });
  }
  if (!Number.isInteger(bookId) || bookId <= 0 || !Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) {
    return Response.json({ ok: false, error: 'That quantity does not look right.' }, { status: 400 });
  }

  const result = await setGroupLine(code, token, bookId, qty, person);

  if (result === 'not-found') {
    return Response.json({ ok: false, error: 'That group basket has expired.' }, { status: 404 });
  }
  if (result === 'sent') {
    return Response.json(
      { ok: false, error: 'That order has already been sent to the shop.' },
      { status: 409 },
    );
  }
  if (result === 'full') {
    return Response.json(
      { ok: false, error: 'This group basket is full. Send it, and start another for the rest.' },
      { status: 409 },
    );
  }

  return Response.json({ ok: true });
};
