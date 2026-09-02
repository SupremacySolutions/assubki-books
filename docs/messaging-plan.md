# A message thread on every order

## Context

There is now real trade on the site — one order sitting at `awaiting_payment`
right now, and **that customer is not on Telegram**. Their only way to reach the
shop is email, which is formal, slow, and lands in a Gmail inbox outside the
app where nothing about it is attached to the order.

Telegram is excellent for the people who connect, and a dead end for everyone
else. The bot cannot open a conversation, so it can only ever reach someone who
opted in first. The shop needs a channel that works for the other half.

**The outcome:** every order carries a conversation. The customer opens it from
the order link they already have; the owner works from the portal, where the
messages sit beside the books, the address and the status. Telegram stops being
a separate place and becomes one more way into the same thread. Email stops
carrying conversation and becomes a doorbell that points back at the site.

This plan is written to be handed to a fresh session. It assumes no memory of
this one.

---

## Settled with the owner

| Question | Answer |
|---|---|
| What does a thread hang off? | **One thread per order.** Authority is the order token; a forwarded link must never expose another order's messages. The portal groups threads by customer so the owner still sees the whole person. |
| Chat before ordering? | **No.** Order threads only. The contact form and Telegram stay as they are for browsers. No unauthenticated thread creation, no second kind of token, no spam surface. |
| What does a notification email carry? | **Sender and a one-line preview, then a link.** Enough to judge urgency, not enough to answer by email. |
| Screenshots? | **Customer only, removed after the order closes.** A payment screenshot shows a bank balance, an account number and a real name, so it does not live for ever. The owner set the window at **six months after the order closes** - long enough to answer a chargeback, a dispute or a question that arrives late. |

---

## What already exists, and must be reused

Read these before writing anything.

- **`getOrder(ref, token)`** — `src/lib/orders.ts:400`. Constant-time compare of
  `orders.access_token`, strips the token from what it returns, indistinguishable
  failure for a wrong ref and a wrong token. **This is the entire auth model for
  the customer side.** Every new customer route calls it and nothing else.
- **`src/pages/api/orders/cancel.ts`** — the template for a customer form POST:
  plain `formData()`, 302 back to `/order?ref=…&t=…`, and a header comment
  explaining why there is no CSRF token (no session, so nothing to forge from).
  Astro's `checkOrigin` is on by default and already enforces same-origin on
  form posts.
- **The 20-second poll** — `src/pages/order/index.astro:597-648`. Already runs on
  the order page: visibility-gated, in-flight guard, one-hour hard stop, silent
  on failure. **Do not add a second poll. Extend this one.**
- **`/api/orders/status`** — already calls `getOrder`, which already does
  `SELECT *`. New columns on `orders` ride along **at no extra read cost**.
- **`src/lib/notify.ts`** — `Promise.allSettled` fan-out, per-channel guards,
  `recordNotifyFailure`/`clearNotifyFailure` writing `settings.last_notify_error`,
  surfaced on the dashboard. New notifications follow this shape exactly.
- **`src/lib/order-status.ts`** — all customer-facing wording lives here so the
  page, the email, the Telegram message and the portal cannot drift. New copy
  goes here, not inline.
- **`src/pages/api/telegram/webhook.ts`** — already accepts customer photos from
  a bound chat (`MAX_SCREENSHOTS = 5`), relays them with `copyToOwner`, and
  discards every text message through `pointAtAHuman`.
- **`src/pages/api/admin/upload.ts`** — the file-validation shape to copy: 8 MB
  cap, MIME allowlist `{jpeg, png, webp}`, R2 write with `httpMetadata`.
- **`src/lib/login-throttle.ts`** — the house rate-limiter: counted in D1
  because module-level counters are useless across ephemeral isolates.
- **The 60-second cache pattern** — `src/lib/db.ts:158`. Copy-pasted, not
  abstracted: a module-level `{at, value}` literal plus a `forgetX()`.

---

## The design

### 1. The thread

One table. `messages` hangs off `orders` and cascades with it.

```sql
-- migrations/0022_messages.sql
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender     TEXT NOT NULL CHECK (sender IN ('customer','owner')),
  via        TEXT NOT NULL CHECK (via IN ('web','telegram')),
  body       TEXT,
  image_key  TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (body IS NOT NULL OR image_key IS NOT NULL)
);
CREATE INDEX idx_messages_order ON messages(order_id, created_at);

ALTER TABLE orders ADD COLUMN unread_for_owner    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN unread_for_customer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN last_message_at     INTEGER;
```

`via` is recorded because "they said it on Telegram" and "they typed it on the
site" are different facts, and the owner should be able to see which.

**The three counters on `orders` are the whole cost story.** Counting messages
per order on the portal list would be a query per row — the shape that once ate
95% of the read budget. They are denormalised instead, incremented in the same
`db.batch()` as the insert and zeroed when the thread is opened. There is
precedent: `orders.payment_proofs` is already a counter of exactly this kind.

The migration is **additive only** — new table, three `ALTER TABLE … DEFAULT`.
There is a live order in production; nothing may rewrite the `orders` table.

New module **`src/lib/messages.ts`**, so the rules exist in one place:
`thread(orderId)`, `postMessage({orderId, sender, via, body, imageKey})`
(insert + counter bump + `last_message_at`, one batch), `markRead(orderId, side)`,
and the caps — `BODY_MAX = 2000`, `IMAGES_PER_ORDER = 5` (the same number
Telegram already enforces), `PER_HOUR = 20`.

### 2. How each side learns there is a message

**The customer** — fold it into the poll that already runs.

`/api/orders/status` gains `unread` and `lastMessageAt` from the row it already
fetched. No new endpoint, no new request, no extra D1 read. When the thread is
open, the page tightens the existing interval from 20 s to 5 s (the group basket
already polls at 5 s, so this is a known cost) and drops back to 20 s when it is
closed. The visibility gate, the in-flight guard and the one-hour stop all stay.

**The owner does not poll at all.** They are bound to the bot
(`settings.owner_telegram_chat_id`), so a customer message is a Telegram DM
straight away via the existing `sendMessage`. The portal's order list and order
page read `unread_for_owner` from the row they already select.

**Notifying the customer of an owner reply** — Telegram if `telegram_chat_id`
is set, otherwise email with sender, a one-line preview and the link.

**Debounce, and mean it.** A full e2e run is about 38 emails, which is most of a
day's free Resend allowance; five replies in a row must not be five emails. Rule:
do not send a second notification for the same order until the customer has read
the thread, or 30 minutes have passed. Cheap to implement — compare
`last_message_at` against a `last_notified_at` column, or store the marker in
`settings`; prefer a fourth column on `orders`, since it is per-order state.

### 3. Telegram becomes an entrance, not a separate room

Today `pointAtAHuman()` throws away every inbound text: *"This bot only handles
orders."* Change it, for a **bound chat with a live order only**, to post the
text into that order's thread as `via: 'telegram'`.

That is the piece that makes the feature coherent. A connected customer types in
Telegram; an unconnected one types on the site; both land in one thread, and the
owner answers both from one box. Unbound chats and chats with no live order keep
the existing brush-off.

The existing photo path stays and additionally records a `messages` row, so a
payment screenshot appears in the thread rather than only as a counter.

**Owner replies from Telegram are explicitly out of scope for now** — it needs a
map from relayed Telegram message ids back to orders. Worth doing later; say so
rather than half-building it.

### 4. Screenshots

A new customer endpoint takes multipart, authorised by `getOrder`. Validation
copied from `api/admin/upload.ts`: 8 MB, `{jpeg, png, webp}`, plus
`IMAGES_PER_ORDER` and the hourly cap.

**The one thing that must not be got wrong:** `src/pages/img/[...key].ts` is a
**public** route with `SERVED_PREFIXES = ['books/', 'uploads/']`. A payment
screenshot must never be reachable from it. Store under a **`proofs/`** prefix,
which that route does not serve, and add a separate token-gated reader —
`/api/orders/proof?ref=…&t=…&id=…` — that calls `getOrder`, confirms the message
belongs to that order, and streams from R2 with `Cache-Control: private, no-store`.
The owner reads the same object through an admin route. **Do not add `proofs/`
to `SERVED_PREFIXES`.**

**Removal on close.** The cron Worker sweeps images for orders that reached
`completed`, `cancelled` or `expired` more than **six months** ago: delete the
R2 object, null `image_key`, keep the message row so the conversation still
reads. The window is set by what the picture might still be needed for — a
chargeback, a dispute, a question months later — rather than by the order it
belongs to. This needs the
`UPLOADS` R2 binding adding to `workers/expire-holds/wrangler.jsonc`, which
currently has only `DB`. The chat says plainly that images are removed when the
order closes, so nobody expects a permanent record.

### 5. Email becomes a doorbell

`src/lib/email.ts` currently sets `replyTo: ownerAddress()` on customer mail, so
replies land in the owner's Gmail, outside the app. Drop it, and add one footer
line to every customer email: this address is not monitored — reply on your
order page (link), or message us on Telegram.

**Keep the existing recovery route working.** Someone who has lost their link
still needs `/api/orders/lookup` (ref + email); make sure the footer and the
contact page both point at it. Do not remove `MessageUs.astro` — it is the
fallback when the token is gone.

---

## Files

**New**
- `migrations/0022_messages.sql`
- `src/lib/messages.ts` — thread reads, `postMessage`, caps, read-marking
- `src/components/Thread.astro` — the conversation, used by both sides
- `src/scripts/thread.ts` — send without reload, poll-driven append, image preview
- `src/pages/api/orders/message.ts` — customer send (text and image)
- `src/pages/api/orders/proof.ts` — token-gated image read
- `src/pages/api/admin/orders/[ref]/message.ts` — owner send
- `src/pages/api/admin/orders/[ref]/proof.ts` — owner image read

**Changed**
- `src/pages/api/orders/status.ts` — return `unread`, `lastMessageAt`
- `src/pages/order/index.astro` — the thread; retune the existing poll
- `src/pages/admin/orders/[ref].astro` — the thread beside the order
- `src/pages/admin/orders/index.astro` — unread badge from the column
- `src/pages/api/telegram/webhook.ts` — inbound text into the thread
- `src/lib/notify.ts` — `notifyNewMessage`, both directions, debounced
- `src/lib/order-status.ts` — the wording
- `src/lib/email.ts` — no-reply, footer
- `docs/messages.md` — the owner's copy-review document, which writes out every
  message the shop sends as it actually arrives. The no-reply footer and the two
  new-message notifications belong in it, or the owner is reviewing wording that
  no longer matches what goes out.
- `workers/expire-holds/` — the image sweep, plus the `UPLOADS` binding
- `scripts/e2e.mjs` + `scripts/lib/e2e-helpers.mjs` — a new suite

---

## Phases

Each ends shippable.

**Before the UI half of Phase 1**, send both design briefs — they are written
out verbatim under *Where Claude Design is worth using* below. The endpoints,
the migration and `messages.ts` can be built while the screens come back; the
component and the two pages should wait for them.

1. **The thread, web only.** Migration, `messages.ts`, both send routes, the
   component, both pages, the status endpoint. Owner learns by Telegram DM.
   Plain form posts — no client JS yet. **This alone solves the live order.**
2. **The enhancement layer.** `thread.ts`: send without reload, poll-driven
   append, the 5 s/20 s retune. Everything still works with it removed.
3. **Screenshots.** Upload, the token-gated reader, the caps, the cron sweep.
4. **Telegram inbound**, and email turned no-reply — together, because that is
   the point at which email stops carrying conversation and the other channels
   have to be able to hold it.

---

## Where Claude Design is worth using

**Two briefs, sent together, before any of the thread UI is built** — that is,
before the second half of Phase 1. The customer side and the owner side have to
be drawn against one another; retrofitting the second to the first is how the
listing editor ended up with a stranded Visibility control.

**Not worth sending:** the migration, the endpoints, the Telegram wiring, the
cron sweep. Nor the emails — they already have their chrome (`shell()`,
`button()`, `itemRows()` in `src/lib/email.ts`) and a new template should match
it rather than be redrawn. The unread badge on the orders list is one chip and
can follow the existing pill; only send it if Brief B is going anyway.

**How the last three handoffs worked:** the brief goes to Claude Design, a zip
of screens comes back, and the screens are read as *intent* and rebuilt against
the real components — never pasted in. Two of the three handoffs proposed
features the shop does not have and they had to be dropped, which is why the
"what the code enforces" and "what not to draw" sections below are not optional
padding. **Everything from here to the end of this section is meant to be sent
verbatim.**

---

### Send this — preamble for both briefs

> # Design brief — a message thread on every order
>
> For **As-Subkī Books** (`SupremacySolutions/assubki-books`, branch `main`), an
> Islamic bookshop in Leicester selling classical Arabic texts and madrasah
> syllabus sets. Two screens to draw.
>
> ## Before you start
>
> The site's redesign is built and live. This adds to that system rather than
> revisiting it. Use what is already in `src/styles/global.css`:
>
> - Colours `--color-navy` `#184485`, `--color-navy-deep` `#0e2a55`,
>   `--color-paper-raised` `#fbfaf7` (page ground), `--color-rule-soft`
>   `#e6e2d9`, `--color-instock` `#2f6b46`, `--color-outstock` `#9a3412`,
>   `--color-brass` `#8a6714` (**price only** — never anything else),
>   `--color-ink-faint` `#6f7787`.
> - Radii: `999px` pills for buttons and chips, `12px` panels, `8px` fields.
> - Type: Spectral 400/500/600 display, IBM Plex Sans 400/500/600 UI,
>   Noto Naskh Arabic for `.ar`.
> - Shop content max-width 1160px, portal 1100px.
> - Motion is background only and switches off under `prefers-reduced-motion`.
>
> Draw every screen at **375px and desktop**.
>
> ## The thing to understand first
>
> **No money moves through this site.** An order is a *request to buy*. The
> customer sends it, the shop replies with a total and payment details, and
> payment is arranged directly. Nothing here takes a card, and nothing in this
> feature may imply otherwise.
>
> **There is no customer login.** A customer's entire authority is a token in
> the link they were emailed. There are no accounts, no avatars, no profile
> pictures, no display names beyond the name they typed at checkout.
>
> ## The hard rule
>
> Do not draw anything the shop cannot do. Each brief lists the exact rules the
> code enforces. **If a state is not listed, it cannot happen.** Previous
> handoffs proposed a live stock count in the header, catalogue filters, "show
> 20 more" and a "decide later" payment option — none existed, and all four had
> to be dropped after the fact.

---

### Send this — Brief A: the conversation, as the customer sees it

> On `/order?ref=…&t=…`, the page a customer reaches from their confirmation
> email or Telegram message. It is a long page already: the order's status and
> journey bar, the books, the delivery or collection details, a cancel control,
> and a "Message us" dialog offering Telegram. **Where the thread goes on that
> page is part of what you are deciding**, and it matters — a customer arriving
> because they were told they have a reply should not have to hunt.
>
> #### What the code enforces
>
> - Messages are **text up to 2000 characters**, or **an image**, or both.
> - The customer may attach **up to 5 images per order**, and **only images**
>   (`jpeg`, `png`, `webp`, 8 MB each). No PDFs, no documents, no voice notes.
> - **Images are deleted six months after the order closes.** The page must say so
>   where someone will read it before they upload, not in a footnote.
> - A message cannot be edited or deleted once sent.
> - Sending is a **plain form post**. The whole flow must work with JavaScript
>   switched off; live updating is an enhancement layered on top.
> - New messages arrive by **polling every 5 seconds while the tab is visible**,
>   stopping after an hour. There is no push, no socket, no typing indicator,
>   and no way to know the other person is present.
> - Read state is **per thread, not per message.** The shop can know "they have
>   opened this", never "they have seen this particular line".
>
> #### States to draw
>
> 1. **No messages yet.** The invitation to start one. This is the most
>    important state in the brief — it is what the customer who does not use
>    Telegram sees, and it has to read as an obvious, easy alternative to email
>    rather than a form nobody uses.
> 2. **A conversation.** Both sides, several messages, clearly whose is whose.
>    A message that arrived from Telegram is marked as such — the shop wants to
>    know which door someone came through.
> 3. **Unread.** The customer has been told there is a reply. How the new
>    messages are distinguished from ones already read, and what happens to that
>    marker once they have looked.
> 4. **Sending, and failed to send.** The site is on a phone in a shop with bad
>    signal at least some of the time. A message that did not go must say so and
>    keep the text.
> 5. **An image in the thread**, plus the control for attaching one and the
>    preview before it is sent. Include the "removed when the order closes" line
>    in place.
> 6. **The limits reached** — the sixth image, and a message over the character
>    count.
> 7. **The thread on a closed order** (`completed`, `cancelled`, `expired`).
>    Readable, not writable, and honest about why.
>
> #### Constraints
>
> - **`/order` stays reachable when the shop is closed for maintenance.** This
>   flow must not assume the rest of the site is up.
> - Telegram is not being replaced. The existing "Message us" dialog stays;
>   decide how it and the thread sit together rather than pretending one of them
>   is gone.
> - On a phone, a chat that pins a compose box to the bottom of the viewport
>   fights a page that also has to scroll through an order. Solve that
>   deliberately either way.

---

### Send this — Brief B: the conversation, as the owner sees it

> A new panel on `/admin/orders/[ref]`, the portal page for one order. That page
> is already dense: the books to pack with totals, a "Confirm and send payment
> details" card, a history built from the order's timestamps, a cancellation
> panel, the next-step buttons, and an aside with the address, phone, email and
> Telegram status. **The thread has to earn its place among those without
> pushing the packing list below the fold.**
>
> #### What the code enforces
>
> - Same message shape as the customer's: text up to 2000 characters, or an
>   image. **The owner cannot attach images** — only the customer can.
> - The owner's reply reaches the customer by **Telegram if they are connected,
>   otherwise email**. The panel must show which, before the owner writes,
>   because it changes how they phrase things. The order row already carries a
>   `✓ Telegram connected` indicator to build on.
> - **The owner is not notified in the portal.** A customer message arrives as a
>   Telegram DM to the owner's phone. The portal is where they *reply*, not
>   where they wait.
> - A count of unread messages sits on the order row in the list at
>   `/admin/orders`.
> - The owner can open a thread on an order that has none yet — **starting the
>   conversation is a real action**, not only replying to one.
> - Everything the owner already sends the customer — the payment message, a
>   cancellation note, a decline note — is **separate from this thread** and
>   stays where it is. Do not merge them into one timeline.
>
> #### States to draw
>
> 1. **The panel with a conversation in it**, and where it sits on the page.
> 2. **Unread**, and what the owner sees on the orders *list* — a count against
>    the row, at both widths.
> 3. **No thread yet**, with the control to start one.
> 4. **Replying**, including the reminder of which channel it will leave by, and
>    what that reminder looks like when the customer is on neither — an email
>    that has hard-bounced is a real state the shop records
>    (`settings.last_email_error`).
> 5. **A screenshot the customer sent**, at a size the owner can actually check
>    a payment reference against, and how they open it larger.
> 6. **Read** — the whole thread, once the customer has opened it. Thread-level
>    only; there are no per-message ticks.
>
> #### Constraints
>
> - **Everything on this page is inside forms that post and reload.** Do not
>   draw anything that implies a nested form — a nested `<form>` is discarded by
>   the browser and its button submits the outer one, which has silently broken
>   this exact page before.
> - The owner works from a phone as often as a desk. 375px is not an
>   afterthought here.

---

### Send this — what not to draw, for both briefs

> - Typing indicators, presence dots, "online now", or anything implying either
>   party is watching. Updates arrive by a 5-second poll and nothing else.
> - Per-message read ticks. Read state exists per thread only.
> - Reactions, emoji pickers, replies-to-a-specific-message, threading,
>   forwarding, editing, or deleting a sent message.
> - Attachments that are not images. No PDFs, no documents, no voice notes.
> - Owner-sent images.
> - Avatars, profile pictures, usernames, or anything else implying accounts.
>   There is no customer login anywhere on this site.
> - A chat available before someone has ordered, a floating chat bubble on the
>   shop, or a support widget on any page other than the order page and the
>   portal.
> - Anything suggesting a payment can be made, confirmed or taken on the site.
> - Unread counts anywhere in the customer-facing header.
---

## Constraints that have bitten this codebase before

- **The build does not typecheck.** Astro compiles with esbuild; an undefined
  name ships and throws at runtime.
- **CSP is `script-src 'self' 'nonce-…'` with no `unsafe-inline`.** No `onclick`
  attributes — put logic in `src/scripts/*.ts` and drive it from `data-*`.
  `connect-src 'self'` also means **a WebSocket would need a CSP change**; polling
  avoids that entirely.
- **`is:inline` + `define:vars` ships verbatim** — plain JS only, no TypeScript.
- **Forms cannot nest.** A send box inside another form breaks silently. This has
  broken this page twice.
- **`img-src 'self' data: blob:`** — `blob:` works for a local preview before
  upload; nothing loads cross-origin.
- **The suite posts to APIs, not through forms**, so form-shaped bugs pass. Check
  the send box in a real browser.
- **A killed test run leaves `E2E …` fixtures** that fail the ledger and
  pagination assertions on the *next* run. That is the rubbish, not the code.

---

## Verification

- `npm run test:e2e` — 444 must stay green, plus a new suite registered in
  `SUITES` as `['messages', messages, true]`:
  a wrong token reaches no thread and no image; a message posts and lands in the
  right order; the counters match `SELECT COUNT(*) FROM messages`; the hourly cap
  and `BODY_MAX` refuse; the image cap refuses the sixth; **`/img/proofs/…`
  returns 404** (the one that matters); the sweep removes images for a closed
  order and keeps the message rows.
- **In a real browser at 375 px and desktop**, both sides, and **with JavaScript
  disabled** — the send box must still post and come back to the thread.
- **Telegram for real** — `npm run test:e2e:prod` sends genuinely, because a mock
  returns success and proves nothing. A reserved MarkdownV2 character in a
  customer's message is exactly the kind of thing that has broken a send before;
  `sendMessage` already retries unformatted, but check it.
- **`npx wrangler d1 insights assubki-books --sort-by reads` after it ships.**
  Usage is ~1.0M rows/day against a 5M limit. The poll is the thing to watch;
  the counters exist so it stays flat.

---

## Adjacent, small, worth doing while in here

`createOrder` carries a Telegram link forward with `WHERE email = ?` — exact and
case-sensitive — while `findOrder` uses `LOWER(email) = LOWER(?)`
(`src/lib/orders.ts:195` vs `:343`). Someone who types `Ali@Example.com` once and
`ali@example.com` next time loses their Telegram connection. One-line fix, and it
matters more once Telegram is a route into the thread.

---

## Still open for the owner

- **Covers:** run *Find a cover* over the 17 photo-less listings, keep what is
  good, photograph the rest. Nothing needs deleting.
- The 18 policy blanks in `docs/policy-blanks.md`.
