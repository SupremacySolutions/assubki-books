# Handoff: cancellation, reservations, listing editor, sold in parts

Four additions to As-Subkī Books (`SupremacySolutions/assubki-books`, branch `main`), drawn
against the brief in `design-brief-2.md`. The twelve-screen redesign is already built; **nothing
here revisits it**, and the landing page is explicitly unchanged — the current one stays.

## About the Design Files
`Redesign.dc.html` is a **design reference created in HTML** — a prototype showing intended look and
behaviour, **not production code to copy**. It is a single-file document using inline styles and a
small streaming runtime. Recreate these designs in the existing Astro codebase using its established
patterns: `src/layouts/Base.astro` and `Admin.astro`, the components in `src/components/`, and the
Tailwind v4 `@theme` in `src/styles/global.css` with its `.btn` / `.field` / `.classmark` /
`.eyebrow` / `.price` classes.

Open the file in a browser. Ids are stable and referenced throughout below:
**3a** cancellation · **3b** reserve states · **3c** mixed basket · **3d** owner reservations ·
**3e** new listing · **3f** existing listing · **3g** sold in parts.
(Turn 4 in the file holds two landing-page explorations that were **rejected** — ignore `#4a` and
`#4b` entirely.)

## Fidelity
**High fidelity.** Colours, type, spacing and copy are final — the copy especially, since most of
this brief is about wording. Covers are striped placeholders; real ones come from R2 via
`/img/[...key]`. Order refs, customers and dates are invented.

---

## 1. Cancelling your own order (3a)

On `/order?ref=…&t=…`. Authority is the token in the URL, so **every control is a plain form post**
and the whole flow works with JavaScript off. There is no modal anywhere.

### Which control appears

| status | control |
|---|---|
| `requested` | "Cancel this order" — cancels outright |
| `awaiting_payment` · `paid` · `dispatched` | "Ask us to cancel" — sends a request |
| `completed` · `cancelled` · `expired` | nothing rendered |

### State 1 — can cancel outright
Sits at the **very foot of the page**, below the books, totals and address — never in the header row
beside "Message the shop". A single hairline `#e6e2d9` above it, then a two-part row: an explanatory
sentence in 14px `#6f7787` on the left, and an **outline pill** on the right (1px `#ddd9d1`,
transparent fill, `#6f7787` text, 10px/18px, radius 999px). Deliberately the quietest control on the
page.

Copy: *"Changed your mind? Nothing has been arranged yet, so you can cancel this straight away and
the copies go back on the shelf."*

### State 2 — can only ask
Visibly a different object: a **white card** (1px `#e6e2d9`, radius 12px, padding 20px 22px) with its
own heading "Need to cancel?", an explanation, and a filled-`#fbfaf7` outline pill reading
**"Ask us to cancel"**. The customer must understand before clicking that this asks rather than does.

Copy: *"We have already quoted you and set these books aside, so cancelling now is something we do
together. Ask, and we will confirm — your order stays live until we do."*

### States 3 + 4 — confirmation, expanded in place
Clicking either control expands a panel **in the page** (no modal, no JS required — the control is a
link to `?confirm=cancel`, the panel is server-rendered). White card with a **3px `#9a3412` left
rule**.

- Heading: "Cancel order ASB-7F42K?" (Spectral 600 19px).
- Warning: *"This cannot be undone. The three books go back on the shelf for someone else, and you
  would need to request them again."*
- **The reason box**: label *"Why are you cancelling?"* followed, in `#6f7787` regular weight, by
  *"— optional, and we will not chase you for an answer"*. Textarea 3 rows, placeholder *"Only if you
  want to tell us."*, max 600 characters with a `0 of 600` counter beneath in tabular numerals.
  **Never required** — submitting empty is a normal path, not an error.
- Buttons: **"Yes, cancel it"** filled `#9a3412`; **"Keep my order"** outline. Both real submits.

On the *request* variant the heading reads **"Ask us to cancel ASB-7F42K?"**, the primary button
reads **"Send the request"**, and the warning is replaced by *"we will reply to confirm — nothing
changes until we do"*.

### State 5 — asked, waiting on the shop
Persists across reload (it is a column on the order, not client state). White card, **3px `#8a6714`
left rule**, a 22px round `?` badge on `rgba(138,103,20,.14)`, then:

*"Asked on 30 August at 14:12. **Your order is still live until we reply** — the shop will get back
to you."*

Beneath, behind a `#f0eee9` hairline, the customer's own reason under the eyebrow **"Your reason"**.
Then the navy "Message the shop" pill.

### State 6 — cancelled
Heading in `#6f7787`, the date, and "The books are back on the shelf." Below, **two side-by-side
cards** that must never be merged into one paragraph:

- **"What you told us"** — the customer's reason column.
- **"Note from the shop"** — the owner's note column.

Either card is **dropped entirely** when its column is empty. Two facts from two people, two boxes.

### Constraints carried through
- No JavaScript anywhere in this flow.
- `/order` stays reachable when the shop is closed for maintenance, so nothing here may depend on
  the rest of the site being up.

---

## 2. Reserving a book that has not arrived (3b, 3c, 3d)

Reservable = `incoming − already reserved`. At zero the control disappears. **A reservation does not
expire** the way a 48-hour basket hold does — it stands until the stock lands.

### Customer: the five buy-card states (3b)
All five are the same white card (1px `#e6e2d9`, radius 12px, padding 22px, shadow
`0 2px 8px rgba(16,24,40,.05)`) with price in IBM Plex 600 32px `#8a6714` and a status pill beside it.

1. **In stock** — unchanged. Pill `#2f6b46` on `rgba(47,107,70,.1)`. Stepper + navy **Add to basket**.
2. **Out of stock, delivery coming** — pill `#9a3412`. A `#fbfaf7` inset panel headed
   **"Delivery on its way"** carrying two lines: *"12 copies expected mid-October."* and, in
   `#6f7787`, *"4 still free to reserve"*. The primary action becomes **"Reserve a copy"** in
   **`#8a6714`**, not navy — a different act deserves a different colour. Foot note:
   *"A reservation is not a hold that runs out — it stands until the delivery lands. Nothing is paid
   now."*
3. **Out of stock, nothing coming** — unchanged. No stepper, no button; the existing ask-us line.
4. **Fully reserved** — pill "Fully reserved" `#8a6714`. Panel still shows the delivery, but reads
   *"All 12 are already spoken for"*. No control at all. *"Ask us and we will add you to the one
   after."*
5. **Already reserved by you** — pill "Reserved for you" `#2f6b46`, panel names the order
   (*"1 copy reserved for you on order ASB-3P88M"*), no control, and a line saying it ships with the
   rest of that order.

### Customer: mixed basket and checkout (3c)
**This is the most important thing in the brief.** The one-parcel sentence appears **twice**, in both
places the customer commits.

- **In the basket**, above the list: a white panel with a **3px `#8a6714` left rule** and a warning
  glyph — *"One book in your basket has not arrived yet, so **the whole order goes out in one parcel
  once everything is here** — expected mid-October."* (It was navy in an earlier draft; it is
  deliberately not, so it reads as information rather than a system banner.)
- **Each unarrived line** is dimmed to 62% opacity on its cover thumbnail and carries a
  `#8a6714` state line: *"Reserved — expected mid-October"*.
- **At stage three of the request**, the same fact restated in a `#fbfaf7` footer row inside the
  summary card, plus the escape hatch: *"Tell us in the box below if you would rather have the
  in-stock books now and pay postage twice."*

### Customer: the order page afterwards (3c)
Status heading **"Waiting on a delivery"**. Top-right, where the hold clock normally sits: eyebrow
"Expected", then **"Mid-October"** in IBM Plex 600 22px `#0e2a55`, and *"we will email if it slips"*.

The journey bar gains its own segment — **"Waiting on a delivery"** in `#8a6714`, sitting between
Paid and Posted at `flex: 1.5` so it reads as the wide, indefinite step it is. It is never a stalled
"Posted".

### Owner: recording a delivery (3d)
Inside "Price, stock and visibility", behind a hairline, a subsection **"A delivery on its way"**:

- **"How many coming"** — a number, 160px.
- **"Roughly when"** — **two selects, never a date picker**: a vagueness word
  (Early / Mid / Late / Sometime in) and a month (October 2026 …). Helper text says why:
  *"Be vague about when — a month you will beat is better than a date you might miss."*
- A live preview strip showing exactly what the customer will read, plus an
  **"8 already reserved"** chip.
- Zero in "how many coming" offers nothing to customers.

### Owner: what is spoken for (3d)
A **"Coming in"** panel — one row per delivery with cover, title, "12 coming · expected mid-October",
a claimed/expected progress bar (`#2f6b46` → `#8a6714` → `#9a3412` as it fills), and an action pill
("Mark arrived" on the one that is due).

### Owner: the delivery lands (3d)
White card, **3px `#2f6b46` left rule**, headed *"Mukhtasar al-Quduri has arrived"*. One number field
("How many arrived") and **"Release the reservations"**. Below, the queue in the order reservations
were made, each row ending in an outcome chip. Explicit rule stated on the page:

*"If fewer arrive than were claimed, the overflow stays reserved and waits for the next delivery —
it is never silently cancelled."*

### Constraints carried through
- No date picker, no countdown, anywhere.
- Nothing takes payment earlier than the shop already does.

---

## 3. Creating a listing, in sections (3e, 3f)

The page is one form that **saves once**. There is no save button per section, and **no nested
`<form>` anywhere** — a nested form is discarded by the browser and its button submits the outer
one, which is exactly how the set builder was broken before.

### Shape
Two columns: a **14rem sticky jump nav** and the sections. Nav items are anchor links with a state
badge on the right; the active one is `#dde3ee` with `#184485` text. A line under the nav states the
contract: *"These jump down the page. It is all one form — one Save at the bottom covers
everything."*

Because these are same-page anchors, the **unsaved-changes warning is untouched** — no navigation
occurs, so `beforeunload` keeps working exactly as it does today.

### Sections, in the order the code needs them
Identity (title, Arabic title, author, publisher, volumes) · Description · Price, stock and
visibility · Subjects · Photos · Telegram · Sold in parts · Delete.

### New listing (3e)
Header reads **"New listing"** / "Not saved yet". Photos, Telegram and Sold in parts render as
**locked placeholder sections** — `#faf9f6` fill, 1px **dashed** `#ddd9d1`, padlock glyph — each
stating its own reason:

- Photos — *"Available once the listing is saved — a photo needs something to attach to."*
- Telegram — *"You can announce it after saving, when there is a page to link to."*
- Sold in parts — *"Set the listing up first, then split it into parts."*

Their nav entries carry the badge *"after saving"* in `#6f7787`.

**Subjects** (about 25 checkboxes) get their own home: a filter pill above
(*"Filter the 26 subjects"*), then a **3-column, 186px-tall scrolling box** with
`break-inside: avoid` on each label. The section heading carries a live count, and when it is zero it
says why it matters: *"a listing with no subject cannot be browsed to"*, with the nav badge in
`#9a3412`.

A **sticky footer bar** inside the form column: *"Unsaved changes — leaving the page will warn you
first"* on the left, **Save listing** on the right.

### Existing listing (3f)
Header is the book's title plus its live `/book/<slug>` path and a "View in the shop" link. Every
section is unlocked; the footer bar reads **"Saved 4 minutes ago"** in `#2f6b46` with **Save changes**.

- **Photos** — 104px thumbnails; the cover ringed in `#184485` and labelled "Cover", the rest offering
  "Make cover"; a dashed "+ Add photos" tile. Note beneath: uploads go up as picked and attach on
  save, and a badly-cropping photo is flagged before it goes live.
- **Telegram** — status chip ("Not announced"), an explanation that re-posting edits the existing
  message rather than adding a new one, and one outline pill.
- **Delete** — its own card with a `rgba(154,52,18,.3)` border and a `#9a3412` heading, stating that
  orders containing the book keep their record.

---

## 4. Sold in parts (3g)

Each part becomes its own listing drawing on **one shared per-volume pool** — selling "volumes 1–2"
leaves fewer complete sets but the same number of "3–4".

### Fixes to what exists
1. **Persistent column headers** above the grid: *Name of the part · First volume · Last volume ·
   Price*, as a 10.5px .14em uppercase `#6f7787` row over a `#e6e2d9` hairline. Placeholders are
   backup, never the only labelling.
2. **A worked example that stays visible** — a `#fbfaf7` inset panel *above* the grid but **using the
   same four-column track**, so each example value sits under the header it belongs to. It does not
   scroll away or disappear on focus. Closes with *"Parts may overlap or leave gaps — it is your
   shelf."*
3. **All four rows are identical.** Same placeholders (Volumes 1–2 / 1 / 2 / 0.00), same input
   styling, same widths. Rows 3 and 4 are no longer different.
4. **Volume columns widened** from 3.6rem to `.8fr` of the grid — room for a spinner.
5. **The price field gains a `£` prefix** and matches its neighbours: the prefix is a span inside the
   field shell, so the border, background and radius are one object.

Above the grid: "Volumes altogether" and "Complete sets on the shelf", both 180px.

### Invalid row
A half-filled row is **refused, never guessed at**. The offending field gets a 1.5px `#9a3412` border
(prefix included), and one message sits under the grid with a warning glyph:

*"Row 2 needs a price. We will not guess one — fill it in or clear the row."*

The Save button drops to 50% opacity. No inference of a missing price or a missing range, ever.

### Already split
Chip *"3 parts live"*, the volume total restated, then one row per part — name (link), `vols 1–2`,
price, availability, Edit. Beneath, a `#fbfaf7` panel **"A delivery has come in"** with a single
"Complete sets" field and **Update**: set the complete sets and every part recalculates from it.
Finally **"Stop selling in parts"** as a `#9a3412` outline pill, with the consequence stated: the part
listings come down, the complete set stays, existing orders keep their record.

---

## Design Tokens
All from `src/styles/global.css`; nothing new is introduced.

| Token | Value | Used for |
|---|---|---|
| navy | `#184485` | primary actions, links |
| navy-deep | `#0e2a55` | portal header, display headings |
| paper-raised | `#fbfaf7` | page ground, field fill |
| card | `#ffffff` | panels |
| rule-soft | `#e6e2d9` | card borders, hairlines |
| rule | `#ddd9d1` | field borders, outline pills |
| ink | `#101828` · ink-soft `#4a5568` · ink-faint `#6f7787` | text |
| brass | `#8a6714` | price · **reserve actions** · the waiting-on-delivery state |
| instock | `#2f6b46` | in stock, saved, arrived |
| outstock | `#9a3412` | out of stock, destructive, invalid |

**Left rules carry meaning throughout:** `#9a3412` irreversible · `#8a6714` waiting on someone ·
`#2f6b46` done.

Type: Spectral 400/500/600 display · IBM Plex Sans 400/500/600 UI · Noto Naskh Arabic for `.ar`.
Radii: 999px pills, 12px panels, 10px insets, 8px fields, 2px covers and classmarks.
Portal content max-width 1100px, shop 1160px.

## Not covered
About, Contact, the four policy pages, 404, the order lookup form, admin sign-in, the single-order
view (`admin/orders/[ref].astro`), the owner's side of a **cancellation request** (approve/decline in
the portal), and the reservation confirmation email.
