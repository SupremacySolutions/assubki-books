import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { forgetHomeRows } from '../../../lib/db';
import { readForm } from '../../../lib/request-body';
import { setSetting } from '../../../lib/settings';
import { parseLayout, shelfIdOf, shelfSection, type SectionId } from '../../../lib/home-layout';

export const prerender = false;

/**
 * Saves the front page's sections: their order, which are showing, and which
 * shelves have a row.
 *
 * The page posts every section in the order it shows them, with `show` for the
 * ones ticked. With scripting on, reordering happens on the page and this sees
 * only the final order. Without it, the arrows are submit buttons and arrive
 * here as `move`, one step at a time - so the screen works either way, and the
 * order in the form is the only statement of what the owner chose.
 *
 * Whatever arrives goes through `parseLayout`, the same check the front page
 * reads with, so a hand-made post cannot store a section the page cannot draw.
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });

  const order = form.getAll('section').map(String) as SectionId[];
  const showing = new Set(form.getAll('show').map(String));
  let sections = order.map((id) => ({ id, show: showing.has(id) }));

  const remove = String(form.get('remove') ?? '');
  if (remove && shelfIdOf(remove as SectionId) !== null) {
    sections = sections.filter((s) => s.id !== remove);
  }

  const add = Number.parseInt(String(form.get('add') ?? ''), 10);
  if (form.has('add_shelf') && Number.isInteger(add)) {
    const id = shelfSection(add);
    if (!sections.some((s) => s.id === id)) sections.push({ id, show: true });
  }

  const [moveId, direction] = String(form.get('move') ?? '').split('|');
  const at = sections.findIndex((s) => s.id === moveId);
  if (at >= 0) {
    const to = direction === 'up' ? at - 1 : at + 1;
    if (to >= 0 && to < sections.length) [sections[at], sections[to]] = [sections[to], sections[at]];
  }

  const { results: shelves } = await env.DB.prepare('SELECT id, path FROM categories').all<{
    id: number;
    path: string;
  }>();
  const clean = parseLayout(JSON.stringify(sections), shelves);
  await setSetting('home_layout', JSON.stringify(clean));

  // The trigger has moved the catalogue's version; this instance should not
  // reuse the one it read a moment ago.
  forgetHomeRows();

  const saved = form.has('add_shelf') ? 'added' : remove ? 'removed' : '1';
  return new Response(null, {
    status: 303,
    headers: { Location: `/admin/front-page?saved=${saved}` },
  });
};
