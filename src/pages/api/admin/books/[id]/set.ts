import type { APIRoute } from 'astro';
import { syncChannelSoon } from '../../../../../lib/publish';
import { env } from 'cloudflare:workers';
import { forgetCategoryCounts, forgetHomeRows } from '../../../../../lib/db';
import { partCandidates } from '../../../../../lib/admin-db';
import { readForm } from '../../../../../lib/request-body';

export const prerender = false;

/**
 * Turns one listing into a set that can also be bought in parts.
 *
 * Each part becomes an **ordinary listing** of its own, linked to the same
 * pool. That is the whole design decision: holds, the ledger, cancellation and
 * the 48-hour expiry sweep keep working untouched, because there is no new
 * kind of thing for them to understand. Only availability is read differently,
 * and only the sale has to reach the pool.
 *
 * The shelf count is per volume rather than a single "sets in stock". Selling
 * volumes 1-2 out of three sets leaves two complete sets and three of volumes
 * 3-4, and no single number says both.
 */

/**
 * One part, from its four fields.
 *
 * Four boxes rather than a line of comma-separated text: asking someone to
 * type "Volumes 1-2, 1-2, 17.00" invites getting the punctuation wrong, and
 * the name and the range read as the same thing said twice.
 *
 * A completely blank row is not an error - the form offers more rows than most
 * sets need - but a half-filled one is, because it means something was meant
 * and mistyped.
 */
/** How many part rows the builder offers, and this reads. */
export const MAX_PARTS = 8;

/*
 * Named by a field prefix rather than a row number, because the same four boxes
 * are now read in two places: the builder's blank rows (`part_0…`) and the row
 * belonging to a part that already exists (`edit_<id>…`). One reader, so a rule
 * about ranges or prices cannot hold on a new part and not on an edited one.
 */
function readPart(form: FormData, prefix: string, volumes: number) {
  const name = String(form.get(`${prefix}_name`) ?? '').trim();
  const fromRaw = String(form.get(`${prefix}_from`) ?? '').trim();
  const toRaw = String(form.get(`${prefix}_to`) ?? '').trim();
  const priceRaw = String(form.get(`${prefix}_price`) ?? '').trim();

  if (!name && !fromRaw && !toRaw && !priceRaw) return 'empty' as const;
  /*
   * Why a row was refused, not merely that it was.
   *
   * Every one of these used to be the same `null`, and every `null` became the
   * same message: "one of those rows is half filled in". So an owner who typed
   * a part covering volumes 1 to 6 of a four volume set was told a row was
   * half filled in, which it was not, and given no hint of what was actually
   * wrong. Three different mistakes wearing one sentence is how this came to
   * be reported as an error that makes no sense.
   */
  if (!name || !fromRaw || !toRaw || !priceRaw) return 'half' as const;

  const from = Number.parseInt(fromRaw, 10);
  const to = Number.parseInt(toRaw, 10);

  // Refused rather than clamped: a part that runs past the end of the set, or
  // backwards, is a typo, and quietly correcting it would put a listing on the
  // shop front that nobody meant.
  if (!(Number.isInteger(from) && Number.isInteger(to))) return 'range' as const;
  if (!(from >= 1 && to >= from && to <= volumes)) return 'range' as const;

  const pence = Math.round(Number(priceRaw.replace(/[^0-9.]/g, '')) * 100);
  if (!Number.isFinite(pence) || pence < 0) return 'price' as const;

  return { name: name.slice(0, 200), from, to, pence };
}

const slugify = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

export const POST: APIRoute = async ({ params, request, locals }) => {
  const id = Number.parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return new Response('Bad request', { status: 400 });

  const book = await env.DB.prepare(
    'SELECT id, slug, title, status, set_id, set_part FROM books WHERE id = ?',
  )
    .bind(id)
    .first<{
      id: number; slug: string; title: string; status: string;
      set_id: number | null; set_part: number;
    }>();
  if (!book) return new Response('No such listing', { status: 404 });

  const form = await readForm(request);
  if (!form) return new Response('Bad request', { status: 400 });
  const action = String(form.get('action') ?? '');
  const back = `/admin/books/${id}`;
  const fail = (why: string) =>
    new Response(null, { status: 302, headers: { Location: `${back}?e=${why}` } });

  // ------------------------------------------------------------------ restock
  if (action === 'restock') {
    if (!book.set_id) return fail('notaset');
    const sets = Math.max(0, Math.min(999, Math.round(Number(form.get('sets')) || 0)));

    /*
     * A shelf count cannot go below what customers already hold.
     *
     * Every volume is checked, not the set as a whole: what is committed
     * against volume 1 is every listing covering volume 1, and "volumes 1-2"
     * and the complete set both do. Taking the pool under that number would
     * create inventory below the claims already made against it - an oversold
     * shelf that no later payment can reconcile.
     *
     * `CHECK (reserved <= stock)` on `books` would abort the batch below
     * anyway, but an aborted batch is an unexplained failure; this is the same
     * refusal with a sentence attached.
     */
    const committed = await env.DB.prepare(
      `SELECT COALESCE(MAX(held), 0) AS floor FROM (
         SELECT COALESCE((
           SELECT SUM(o.reserved) FROM books o
            WHERE o.set_id = v.set_id
              AND v.volume BETWEEN o.set_from AND o.set_to
         ), 0) AS held
         FROM book_set_stock v WHERE v.set_id = ?1
       )`,
    )
      .bind(book.set_id)
      .first<{ floor: number }>();
    if (sets < (committed?.floor ?? 0)) return fail('heldsets');

    /*
     * The pool and the listings' own `stock`, together.
     *
     * `stock` on a set member is not what decides availability - the per-volume
     * pool is - but `books` carries CHECK (reserved <= stock), so a listing
     * whose stock is stale can never be held at all. Creating a set writes the
     * same number to both (see the create path below); restocking wrote only
     * the pool, so a set that had sold out came back with availability saying
     * two and every checkout refused by a constraint reading zero.
     *
     * One batch, because a pool that has moved and a listing that has not is
     * exactly the disagreement being fixed.
     */
    /*
     * The same condition again, inside the write.
     *
     * The count above is read before the transaction, so it answers for the
     * moment it ran and not the moment the pool moves. Two reservations landing
     * in between - one on the complete set, one on an overlapping part - each
     * leave their own listing satisfying CHECK (reserved <= stock) while
     * together claiming two copies of a volume the pool now says there is one
     * of. Per-listing constraints cannot see a sum across listings; only this
     * predicate can, and it has to be evaluated where the write happens.
     *
     * Both statements carry it, so neither the pool nor the shadow `stock` can
     * move without the other.
     */
    const roomForClaims = `NOT EXISTS (
      SELECT 1 FROM book_set_stock v
       WHERE v.set_id = ?2
         AND ?1 < COALESCE((SELECT SUM(o.reserved) FROM books o
                             WHERE o.set_id = v.set_id
                               AND v.volume BETWEEN o.set_from AND o.set_to), 0))`;
    const [pool] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE book_set_stock SET have = ?1 WHERE set_id = ?2 AND ${roomForClaims}`,
      ).bind(sets, book.set_id),
      /*
       * The same condition, not a look at the result.
       *
       * This asked whether some volume already stood at the new number, which
       * an uneven pool can satisfy before the transaction begins - a pool is
       * routinely uneven after parts have sold. So a refused restock still
       * rewrote every listing's stock: the pool kept volume 2 at two while the
       * listings dropped to one, and a later part checkout failed against a
       * copy that was physically free.
       *
       * `roomForClaims` names only the new count and the claims against each
       * volume, never `have`, so it reads the same in both statements. Both
       * fire or neither does, which is what "rejected" has to mean.
       */
      env.DB.prepare(
        `UPDATE books SET stock = ?1, updated_at = unixepoch()
          WHERE set_id = ?2 AND ${roomForClaims}`,
      ).bind(sets, book.set_id),
    ]);
    /* Nothing moved: somebody reserved a copy while this was being decided. */
    if (!pool.meta.changes) return fail('heldsets');

    forgetCategoryCounts();
    forgetHomeRows();
    await syncChannelSoon(locals, new URL(request.url).origin, [id]);
    return new Response(null, { status: 302, headers: { Location: `${back}?saved=1` } });
  }

  // -------------------------------------------------------------------- adopt
  if (action === 'adopt') {
    if (book.set_id) return fail('alreadyset');

    const volumes = Math.round(Number(form.get('volumes')) || 0);
    if (!(volumes >= 2 && volumes <= 200)) return fail('volumes');

    /*
     * Take listings that already exist and make them the parts of this set.
     *
     * The create path builds part listings from nothing, which is right the
     * first time and wrong when the parts are already in the catalogue - they
     * carry their own covers, descriptions and channel posts, and rebuilding
     * them would strand all of it on rows nobody links to.
     */
    /*
     * The same candidates the page offered, worked out again here.
     *
     * A form field is a claim, not a fact: `adopt_<id>` names any row in the
     * table, and without asking the question a second time the endpoint would
     * fold an unrelated listing into the set - one the page never showed and
     * the owner never saw. The `set_id IS NULL` guard on the UPDATE only stops
     * a listing already spoken for; it says nothing about whether this one
     * belongs.
     */
    const offered = new Set((await partCandidates(book)).map((c) => c.id));

    const adopted: { id: number; from: number; to: number }[] = [];
    for (const key of [...form.keys()]) {
      const match = key.match(/^adopt_(\d+)$/);
      if (!match || form.get(key) === null) continue;
      const partId = Number(match[1]);
      if (!offered.has(partId)) return fail('stranger');
      const from = Number.parseInt(String(form.get(`from_${partId}`) ?? ''), 10);
      const to = Number.parseInt(String(form.get(`to_${partId}`) ?? ''), 10);
      // Refused rather than guessed, the same as the builder's own rows - and
      // named the same way, so "which volumes" is answered rather than hinted.
      if (!(Number.isInteger(from) && Number.isInteger(to))) return fail('range');
      if (!(from >= 1 && to >= from && to <= volumes)) return fail('range');
      adopted.push({ id: partId, from, to });
    }
    if (adopted.length === 0) return fail('nonepicked');

    // Everything the set can supply comes from the whole set's own stock: it is
    // the count of complete sets on the shelf, which is what a volume count is.
    const sets = Math.max(0, Math.min(999, Math.round(Number(form.get('sets')) || 0)));

    /*
     * Header, pool and attachments in one transaction.
     *
     * The header used to be inserted on its own and everything else batched
     * after it, so a failure in the batch left a `book_sets` row describing a
     * set that does not exist - no volumes, nothing attached to it.
     *
     * The id is taken once, straight after the insert and before any other
     * INSERT can move `last_insert_rowid()`, by writing it onto the listing
     * that becomes the complete set. Everything after that reads it back from
     * there, so no statement depends on the sequence number a second time.
     */
    const statements = [
      env.DB.prepare('INSERT INTO book_sets (name, volumes) VALUES (?, ?)').bind(
        book.title.slice(0, 200),
        volumes,
      ),
      // This listing is the complete set, and carries the new id for the rest.
      env.DB.prepare(
        `UPDATE books SET set_id = last_insert_rowid(), set_from = 1, set_to = ?1,
                          volumes = ?1, stock = ?2, updated_at = unixepoch()
          WHERE id = ?3`,
      ).bind(volumes, sets, id),
    ];
    const setOf = '(SELECT set_id FROM books WHERE id = ?1)';
    for (let v = 1; v <= volumes; v++) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO book_set_stock (set_id, volume, have) VALUES (${setOf}, ?2, ?3)`,
        ).bind(id, v, sets),
      );
    }
    for (const part of adopted) {
      /*
       * Only the set columns are written. Title, price, cover, description and
       * telegram_message_id are left exactly as they are - that is the whole
       * point of adopting rather than creating.
       */
      statements.push(
        env.DB.prepare(
          `UPDATE books SET set_id = ${setOf}, set_from = ?2, set_to = ?3, volumes = ?4,
                            stock = MAX(stock, ?5), set_part = 1, updated_at = unixepoch()
            WHERE id = ?6 AND set_id IS NULL`,
        ).bind(id, part.from, part.to, part.to - part.from + 1, sets, part.id),
      );
    }

    await env.DB.batch(statements);
    forgetCategoryCounts();
  forgetHomeRows();
  await syncChannelSoon(locals, new URL(request.url).origin, [id]);
    return new Response(null, { status: 302, headers: { Location: `${back}?saved=1` } });
  }

  // --------------------------------------------------------------------- parts
  /*
   * Changing the parts of a set that is already selling.
   *
   * Everything before this was one-way: build the parts, or take them all down
   * and start again. A price that needed correcting, a part the owner wanted to
   * stop offering, a range typed wrong - each of them meant unsplitting, which
   * archives every part listing, strands its cover and its channel post, and
   * leaves the set to be rebuilt from nothing. So in practice the parts were
   * whatever they were on the day they were created.
   *
   * What may change freely is what the shop *says*: a part's name and its price.
   * Neither reaches an order already placed - `order_items` snapshots the title
   * and the price at checkout precisely so a later edit cannot rewrite what was
   * agreed.
   *
   * What may not change under a customer is which volumes a part covers. A hold
   * is a claim on particular volumes of the pool, and moving the range would
   * move the claim to volumes nobody reserved. Same for withdrawing a part
   * somebody is holding. Both are refused by name rather than silently allowed.
   */
  if (action === 'parts') {
    if (!book.set_id) return fail('notaset');
    /*
     * Only from the listing, never from one of its parts.
     *
     * The read below asks for "every part of this set except the row this page
     * is", which is the right question from the listing and the wrong one from a
     * part: it would leave that part out of its own edit and treat the rest as
     * the whole picture. The portal no longer offers the panel on a part's page,
     * and this is what makes that true of the endpoint as well.
     */
    if (book.set_part) return fail('notthelisting');

    const set = await env.DB.prepare('SELECT volumes FROM book_sets WHERE id = ?')
      .bind(book.set_id)
      .first<{ volumes: number }>();
    if (!set) return fail('notaset');
    const volumes = set.volumes;

    /*
     * The parts as they stand, with what each is holding.
     *
     * Read here rather than trusted from the form: the form says which id it
     * means, and nothing more about it may be taken on the form's word - a
     * hand-made POST naming a part of somebody else's set would otherwise be
     * edited by this.
     */
    const { results: existing } = await env.DB.prepare(
      `SELECT id, title, price_pence, set_from, set_to, reserved
         FROM books
        WHERE set_id = ?1 AND id <> ?2 AND set_part = 1 AND deleted_at IS NULL
          AND status <> 'archived'
        ORDER BY set_from, id`,
    )
      .bind(book.set_id, id)
      .all<{ id: number; title: string; price_pence: number; set_from: number; set_to: number; reserved: number }>();
    const byId = new Map(existing.map((p) => [p.id, p]));

    const statements: D1PreparedStatement[] = [];
    let remaining = existing.length;

    // ----- the parts that already exist ------------------------------------
    for (const part of existing) {
      if (form.get(`remove_${part.id}`) !== null) {
        // A part somebody is holding cannot be withdrawn: the copies are
        // promised, and the order that promised them still points here.
        if (part.reserved > 0) return fail('heldpart');
        /*
         * Archived rather than deleted, exactly as unsplit does it. An order
         * that bought this part keeps a row to point at - `order_items` holds
         * the title and price, but the link back is what the portal reads to
         * show what was sold, and deleting it would take the stock ledger with
         * it.
         */
        statements.push(
          env.DB.prepare(
            `UPDATE books SET status = 'archived', set_id = NULL, set_from = NULL,
                              set_to = NULL, set_part = 0, stock = 0,
                              updated_at = unixepoch()
              WHERE id = ?1 AND set_id = ?2 AND reserved = 0`,
          ).bind(part.id, book.set_id),
        );
        remaining -= 1;
        continue;
      }

      const row = readPart(form, `edit_${part.id}`, volumes);
      if (row === 'empty') continue;            // untouched by this form
      if (typeof row === 'string') return fail(row);

      // Moving the range under a live hold would move the claim to volumes
      // nobody reserved. The name and the price are free to change.
      if ((row.from !== part.set_from || row.to !== part.set_to) && part.reserved > 0) {
        return fail('heldrange');
      }

      statements.push(
        env.DB.prepare(
          `UPDATE books SET title = ?3, price_pence = ?4, set_from = ?5, set_to = ?6,
                            volumes = ?7, updated_at = unixepoch()
            WHERE id = ?1 AND set_id = ?2
              AND (reserved = 0 OR (set_from = ?5 AND set_to = ?6))`,
        ).bind(part.id, book.set_id, row.name, row.pence, row.from, row.to, row.to - row.from + 1),
      );
    }

    // ----- parts being added ----------------------------------------------
    const added = Array.from({ length: MAX_PARTS }, (_, i) => readPart(form, `part_${i}`, volumes));
    const wrongNew = added.find((r) => r === 'half' || r === 'range' || r === 'price');
    if (wrongNew) return fail(wrongNew);
    const fresh = added.filter(
      (r): r is Exclude<typeof r, 'empty' | 'half' | 'range' | 'price'> => typeof r === 'object',
    );

    if (fresh.length) {
      /*
       * A new part starts with the shelf it is being sold from.
       *
       * `stock` on a set member is not what decides availability - the pool is -
       * but `books` carries CHECK (reserved <= stock), so a part inserted with
       * nothing could never be held at all. The create path writes the same
       * number for the same reason.
       */
      const pool = await env.DB.prepare(
        'SELECT COALESCE(MIN(have), 0) AS sets FROM book_set_stock WHERE set_id = ?',
      )
        .bind(book.set_id)
        .first<{ sets: number }>();

      /*
       * Slugs have to be free, and `books.slug` is UNIQUE.
       *
       * A range that was offered before and withdrawn leaves an archived row
       * holding `…-1-2`, so reusing the obvious name would abort the whole
       * batch on a constraint. Taken names are read once and a suffix added.
       */
      const { results: taken } = await env.DB.prepare(
        'SELECT slug FROM books WHERE slug LIKE ?1',
      )
        .bind(`${slugify(book.slug)}-%`)
        .all<{ slug: string }>();
      const used = new Set(taken.map((t) => t.slug));
      const freeSlug = (from: number, to: number) => {
        const base = `${slugify(book.slug)}-${from}-${to}`.slice(0, 110);
        let candidate = base;
        for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
        used.add(candidate);
        return candidate;
      };

      for (const p of fresh) {
        statements.push(
          env.DB.prepare(
            `INSERT INTO books (slug, title, price_pence, stock, reserved, status,
                                set_id, set_from, set_to, volumes, set_part)
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9, 1)`,
          ).bind(
            freeSlug(p.from, p.to),
            p.name,
            p.pence,
            pool?.sets ?? 0,
            book.status,
            book.set_id,
            p.from,
            p.to,
            p.to - p.from + 1,
          ),
        );
        remaining += 1;
      }
    }

    if (!statements.length) return fail('nochange');
    /*
     * Removing the last part is not an edit.
     *
     * It is "stop selling in parts", which has its own button, puts the pool
     * back onto the listing's own stock and tidies the set away. Letting this
     * do it instead would leave a set header with one listing attached and a
     * per-volume pool nothing reads.
     */
    if (remaining < 1) return fail('lastpart');

    await env.DB.batch(statements);
    forgetCategoryCounts();
    forgetHomeRows();
    await syncChannelSoon(locals, new URL(request.url).origin, [id]);
    return new Response(null, { status: 302, headers: { Location: `${back}?saved=1` } });
  }

  // ------------------------------------------------------------------ unsplit
  if (action === 'unsplit') {
    if (!book.set_id) return fail('notaset');

    /*
     * The parts come down; the complete set stays and goes back to being an
     * ordinary listing with its own stock.
     *
     * Part listings are archived rather than deleted. An order that bought
     * "volumes 1-2" has to keep pointing at something - order_items snapshots
     * the title and price, but the link back to the listing is what the portal
     * uses to show what was sold, and deleting the row would cascade the stock
     * ledger with it.
     */
    const pool = await env.DB.prepare(
      'SELECT MIN(have) AS sets FROM book_set_stock WHERE set_id = ?',
    )
      .bind(book.set_id)
      .first<{ sets: number | null }>();

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE books SET status = 'archived', set_id = NULL, set_from = NULL, set_to = NULL,
                          set_part = 0, updated_at = unixepoch()
          WHERE set_id = ? AND id <> ?`,
      ).bind(book.set_id, id),
      // The whole set keeps selling, now on a count of its own.
      env.DB.prepare(
        `UPDATE books SET set_id = NULL, set_from = NULL, set_to = NULL,
                          stock = MAX(?, reserved), updated_at = unixepoch()
          WHERE id = ?`,
      ).bind(Math.max(0, pool?.sets ?? 0), id),
      env.DB.prepare('DELETE FROM book_set_stock WHERE set_id = ?').bind(book.set_id),
      env.DB.prepare('DELETE FROM book_sets WHERE id = ?').bind(book.set_id),
    ]);

    forgetCategoryCounts();
  forgetHomeRows();
  await syncChannelSoon(locals, new URL(request.url).origin, [id]);
    return new Response(null, { status: 302, headers: { Location: `${back}?saved=1` } });
  }

  // ------------------------------------------------------------------- create
  if (action !== 'create') return fail('badaction');
  if (book.set_id) return fail('alreadyset');

  const volumes = Math.round(Number(form.get('volumes')) || 0);
  if (!(volumes >= 2 && volumes <= 200)) return fail('volumes');
  const sets = Math.max(0, Math.min(999, Math.round(Number(form.get('sets')) || 0)));

  /*
   * Eight, not four.
   *
   * Four was enough for a work split into halves or quarters, which is what
   * this was built for. It is not enough for the case that turned up: six
   * separate books by one author, sold singly or as the six. The owner had the
   * listing and no way to describe it - the fifth and sixth rows did not
   * exist. Eight covers that with room spare, and an empty row still costs
   * nothing.
   */
  const rows = Array.from({ length: MAX_PARTS }, (_, i) => readPart(form, `part_${i}`, volumes));
  /* Whichever is wrong, said by name. `noparts` is its own answer: "half
     filled in" made no sense at all when every row was empty. */
  const wrong = rows.find((r) => r === 'half' || r === 'range' || r === 'price');
  if (wrong) return fail(wrong);
  const parts = rows.filter(
    (r): r is Exclude<typeof r, 'empty' | 'half' | 'range' | 'price'> => typeof r === 'object',
  );
  if (parts.length === 0) return fail('noparts');

  /*
   * Header, pool and part listings in one transaction - see the note on the
   * adopt path above. The header used to be inserted on its own, so a failure
   * anywhere in the batch left a set with no volumes and nothing attached.
   */
  const statements = [
    env.DB.prepare('INSERT INTO book_sets (name, volumes) VALUES (?, ?)').bind(
      book.title.slice(0, 200),
      volumes,
    ),
    /*
     * This listing becomes the complete set - it already has the cover, the
     * description and any channel post, and re-creating all that would be
     * worse than reusing it. It also carries the new id for everything after,
     * taken before any other INSERT can move `last_insert_rowid()`.
     */
    env.DB.prepare(
      `UPDATE books SET set_id = last_insert_rowid(), set_from = 1, set_to = ?1,
                        volumes = ?1, stock = ?2, updated_at = unixepoch()
        WHERE id = ?3`,
    ).bind(volumes, sets, id),
  ];
  const setOf = '(SELECT set_id FROM books WHERE id = ?1)';
  for (let v = 1; v <= volumes; v++) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO book_set_stock (set_id, volume, have) VALUES (${setOf}, ?2, ?3)`,
      ).bind(id, v, sets),
    );
  }

  for (const p of parts) {
    /*
     * `stock` is set on each part too, and it is not what decides availability
     * - the pool is. It is here because `books` carries CHECK (reserved <=
     * stock), so a part with no stock could never be held at all. The
     * availability sum ignores it.
     */
    statements.push(
      env.DB.prepare(
        `INSERT INTO books (slug, title, price_pence, stock, reserved, status,
                            set_id, set_from, set_to, volumes, set_part)
         VALUES (?2, ?3, ?4, ?5, 0, ?6, ${setOf}, ?7, ?8, ?9, 1)`,
      ).bind(
        id,
        `${slugify(book.slug)}-${p.from}-${p.to}`.slice(0, 120),
        p.name,
        p.pence,
        sets,
        book.status,
        p.from,
        p.to,
        p.to - p.from + 1,
      ),
    );
  }

  await env.DB.batch(statements);
  forgetCategoryCounts();
  forgetHomeRows();
  await syncChannelSoon(locals, new URL(request.url).origin, [id]);
  return new Response(null, { status: 302, headers: { Location: `${back}?saved=1` } });
};
