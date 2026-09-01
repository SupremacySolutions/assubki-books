# Design brief — cancellation, reservations, and two portal screens

For Claude Design. Four things to draw for **As-Subkī Books**
(`SupremacySolutions/assubki-books`, branch `main`).

## Before you start

The redesign from the last handoff is **built and live** across all twelve
screens. This brief adds to that system rather than revisiting it. Everything
you draw should use what is already in `src/styles/global.css`:

- Colours `--color-navy` `#184485`, `--color-navy-deep` `#0e2a55`,
  `--color-paper-raised` `#fbfaf7` (page ground), `--color-rule-soft` `#e6e2d9`,
  `--color-instock` `#2f6b46`, `--color-outstock` `#9a3412`,
  `--color-brass` `#8a6714` (price only), `--color-ink-faint` `#6f7787`.
- Radii: `999px` pills for buttons and chips, `12px` panels, `8px` fields.
- Type: Spectral 400/500/600 display, IBM Plex Sans 400/500/600 UI,
  Noto Naskh Arabic for `.ar`.
- Shop content max-width 1160px, portal 1100px.
- Motion is background only and switches off under `prefers-reduced-motion`.

**The hard rule:** do not draw anything the shop cannot do. The last handoff
proposed a live stock count in the header, catalogue filters, "show 20 more"
and a "decide later" payment option, none of which existed, and all four had to
be dropped. Each brief below lists the exact rules the code enforces. If a
state is not listed, it cannot happen.

---

## 1. Cancelling your own order — customer

On `/order?ref=…&t=…`, the page a customer reaches from their confirmation
email or Telegram message.

### The rule the code enforces

| order status | what cancelling does |
|---|---|
| `requested` | cancels immediately; the copies go back on the shelf at once |
| `awaiting_payment` · `paid` · `dispatched` | sends a **request** to the shop, which the owner approves or declines |
| `completed` · `cancelled` · `expired` | nothing to cancel — show no control at all |

The line falls where the shop sends payment details. Before that the customer
owes nothing and nothing has been arranged, so the cancellation is theirs to
make. After it the owner has quoted a total and set books aside, so it becomes
a conversation.

### States to draw

1. **Can cancel outright.** The control at rest. Must not look like a primary
   action — it sits below the order, not beside "Message the shop".
2. **Can only request.** Visibly a different thing from (1). The customer must
   understand before they click that this asks rather than does.
3. **Confirmation step.** Irreversible, so it cannot happen on one tap. Draw
   whatever form this takes — an expanding panel is likely better than a modal
   here, since the page must work without JavaScript.
4. **The reason box.** "Why are you cancelling?", free text, up to 600
   characters, **never required**. A customer who just wants out must be able
   to leave it blank and go.
5. **Request sent, waiting on the shop.** Persists across a reload. Must say
   the order is still live until the shop replies, because it is.
6. **Cancelled and finished.** This already exists on the page and shows the
   shop's own note. It needs to accommodate the customer's stated reason too —
   two different facts from two different people, never merged.

### Constraints

- There is no customer login. Authority is the token in the URL, so every
  action is a plain form post and everything must work with JavaScript off.
- The customer's reason and the owner's note are separate columns and must
  never be presented as one voice.
- `/order` stays reachable when the shop is closed for maintenance, so this
  flow must not assume the rest of the site is up.

---

## 2. Reserving a book that has not arrived

The owner buys stock that takes weeks to arrive and wants to let people claim
copies from a delivery before it lands.

### The rule the code enforces

A listing gains **how many are coming** and **roughly when**. Reservable is
`incoming − already reserved`. At zero the book is fully reserved and the
control disappears. A reservation does **not** expire after 48 hours the way an
ordinary basket hold does — it lasts until the stock arrives.

A reservation is an ordinary order carrying an unarrived line. **A mixed basket
is one order that goes out complete**: one parcel, one postage, dispatched once
everything has arrived.

### Customer states to draw

1. In stock — unchanged, for reference.
2. **Out of stock, delivery coming**: how many are expected, roughly when, and
   how many are still free to reserve. The primary action becomes "Reserve a
   copy" rather than "Add to basket".
3. Out of stock, nothing coming — unchanged; the existing "Ask us" line.
4. **Fully reserved**: a delivery is coming but every copy is spoken for.
5. **Already reserved by this customer**, seen on a return visit.

### In the basket and at checkout

A line that has not arrived must be marked as such with its expected timing,
and the order must carry **one plain sentence** that the whole thing goes out
when everything has arrived. This is the most important thing in this brief. A
customer who misses it will chase a parcel that was never sent, and that is a
complaint the shop cannot answer.

### On the order page afterwards

An order waiting on stock needs a state in the journey bar that reads honestly
as waiting, rather than pretending to be one of the normal steps.

### Owner side

- Where the owner records a delivery on the listing editor: how many, expected
  when.
- How the portal shows what is spoken for before the box arrives — the owner
  needs to know that 8 of the 12 coming are already claimed.
- What the owner sees when the delivery lands and reservations need turning
  into ordinary orders.

### Constraints

- **"Expected when" is deliberately vague** — a month or a part of a month, not
  a promised date. Deliveries slip, and a hard date the shop misses is worse
  than a soft one it beats. Do not draw a date picker or a countdown.
- Nothing here takes payment any earlier than the shop already does. No card
  details are handled anywhere on this site.

---

## 3. Creating a listing, in sections

`/admin/books/new` and `/admin/books/[id]` are the same page. It is currently
one long two-column form — nine fields, a subject checklist, photos, Telegram,
the set builder and delete, all visible at once. The customer's request flow was
split into three steps and reads far better; this deserves the same.

**The groups, in the order the code needs them:** identity (title, Arabic title,
author, publisher, volumes) · description · price, stock and visibility ·
subjects · photos · Telegram · sold in parts · delete.

### Constraints

- **A new listing and an existing one are genuinely different shapes.** Photos
  and Telegram cannot be used until the listing exists. Draw both.
- **Everything stays inside one form that saves once.** Do not imply a save
  button per section. This page has already been broken once by nesting
  forms — a nested `<form>` is discarded by the browser and its button submits
  the outer one, which meant the set builder never worked at all.
- The unsaved-changes warning must survive whatever navigation you propose.
- The subject list runs to about 25 checkboxes and needs somewhere sensible to
  live.

---

## 4. Sold in parts

The section that turns one listing into a set which can be bought whole **or**
in named parts. Each part becomes its own listing sharing one per-volume stock
pool, so selling "volumes 1–2" leaves the shop with fewer complete sets but the
same number of "volumes 3–4".

The owner supplies: how many volumes altogether, how many complete sets are on
the shelf, and up to four parts, each with a **name**, a **first volume**, a
**last volume** and a **price**.

### What is wrong with it now

- The four part columns have **no visible headers**. The only labelling is
  placeholder text, which disappears the moment you type, plus a sentence
  *below* the grid explaining the column order.
- Rows 3 and 4 use different placeholders from rows 1 and 2, so the block looks
  inconsistent and half-broken.
- The volume-number columns are 3.6rem wide — too tight for a number spinner.
- The price field has no £ prefix and is a different input type from its
  neighbours.

### Draw

1. Persistent column headers.
2. A worked example that **stays visible while typing** — the current one is
   prose above a grid and is gone from mind by the time you reach row two.
3. The already-split state: the existing parts listed, plus the control that
   sets the shelf count when a delivery arrives.
4. An invalid row. A half-filled row is **refused, not guessed at** — the code
   will not infer a missing price or a missing range.

---

## What not to draw

- A live stock count in the site header.
- Catalogue filters beyond "In stock only", which exists.
- "Show 20 more" — the catalogue uses prev/next pagination.
- A "decide later" payment option.
- A customer login, account area, or saved addresses.
- Any date picker for expected stock.
