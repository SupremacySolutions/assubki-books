# Handoff: sales, the order discount, and finding a cover

Three additions to As-Subkī Books (`SupremacySolutions/assubki-books`, branch `main`), drawn against
the third design brief. Everything previously handed off — the twelve-screen redesign, cancellation,
reservations, the listing editor, sold in parts — is already implemented and **is not revisited
here**.

## About the Design Files
`Redesign.dc.html` is a **design reference created in HTML** — a prototype showing intended look and
behaviour, **not production code to copy**. Recreate these designs in the existing Astro codebase
using its established patterns: `src/layouts/Base.astro` and `Admin.astro`, the components in
`src/components/`, and the Tailwind v4 `@theme` in `src/styles/global.css` with its `.btn` /
`.field` / `.classmark` / `.eyebrow` / `.price` classes.

Open the file in a browser. Ids are stable and referenced below:

| id | screen |
|---|---|
| **5a** | sale row on the home page |
| **5b** | the sale card close up, right and wrong |
| **5c** | book page on sale |
| **5d** | basket and request — savings and the order discount |
| **5e** | a catalogue full of sale items |
| **6a** | `/admin/sales` — the list |
| **6b** | adding books and setting a percentage each |
| **6c** | create · preview · go live · end · the Settings order discount |
| **7a** | find a cover — four states |

## Fidelity
**High fidelity.** Colours, type, spacing and copy are final. Two exceptions: covers are striped
placeholders (real ones come from R2 via `/img/[...key]`), and customer names, order refs and
takings figures are invented.

**Every money figure in 5d is computed, not typed.** The prototype derives each line from unit price
× quantity × percentage, then derives full price, sale saving, threshold test, order discount,
subtotal and total saved from those lines. Do the same in the app — see *The arithmetic* below.

---

## Brief A — A sale, as the customer sees it

### The rule being expressed
One sale live at a time. **A percentage per book**, so two books in the same sale are off by
different amounts. The headline — "up to 20% off" — is **the largest percentage in the sale, always
calculated, never typed**.

### The three facts, and the one colour rule that matters (5b)
Every sale price anywhere on the site is the same three facts in the same order: **new price · old
price struck through · percentage badge**.

`--color-brass` (`#8a6714`) is **reserved for the price** throughout the site. Therefore:

- **New price** — brass, 600 weight, unchanged size. It is still the price.
- **Old price** — `#6f7787`, 400 weight, one step smaller, `text-decoration-thickness: 1px`.
  **Never brass.** Two brass numbers side by side and the customer cannot tell which one they pay.
- **Badge** — `#9a3412` fill, white text, pill, **top-left of the cover**. It carries *that book's*
  percentage, never the sale headline.
- Sale red never touches the price itself. Red is the badge and out-of-stock; brass is money.

5b draws both failure modes as explicit "wrong" panels — keep them in mind when reviewing.

### The home page row (5a)
Sits **immediately below the hero, above "Browse the shelves"** — the first thing after the fold.
It reuses the existing row shape exactly: heading left, link right, hairline `#e6e2d9` beneath, then
the same **five-across card grid** with `column-gap: 28px` / `row-gap: 44px`.

What is new inside that shape:
- The sale's **own name** as the Spectral 600 26px heading — "Back to School Sale", not "Sale".
- A calculated headline pill beside it: "Up to 20% off", 11px 600, .14em, uppercase, `#9a3412` on
  `rgba(154,52,18,.1)`.
- An optional owner-written line beneath in 14.5px `#4a5568`.
- "All 18 →" on the right, matching the existing "All new arrivals →".

### The book page (5c)
The same three facts with room to breathe, inside the existing buy card:
- New price **IBM Plex 600 34px** brass · old price **400 18px** `#6f7787` struck · a
  **"Save £4.00"** pill in `#9a3412` on a 10% tint.
- A line beneath: "20% off in the [Back to School Sale]" — the sale name links to the sale page —
  then the existing stock phrase.
- The badge scales up to 13px on the cover, top-left, and the sale name also appears as a
  `#9a3412` classmark-style chip alongside the real classmarks.
- The hold explainer is unchanged. **Nothing about a sale may suggest money moves on the site.**

### Basket and request (5d)
Per line: reduced price in brass with the original struck beneath it, and a `#9a3412` note naming
the sale and the percentage. **The struck price renders only on lines that are actually reduced** —
a full-price line in a discounted basket shows one number.

The summary is one stack of rows, in this order:

1. **Full price** — the undiscounted total, struck through in `#6f7787`.
2. **[Sale name]** — the sale saving, `#9a3412`, negative.
3. **The order discount**, which has two states:
   - **Below the threshold** — not a row but a **prompt panel**: white, 1px `#e6e2d9`, **3px
     `#8a6714` left rule**, reading *"Spend £23.10 more and 10% comes off the whole order."* The
     amount is computed from the current post-sale total, never a round guess.
   - **Qualified** — its own row like any other: *"10% off orders over £85 · −£8.83"*.
4. **Subtotal** — brass, 23px, above the existing postage caveat.
5. **"You save £22.03"** in `#2f6b46`, only when something was saved.

Stage three of the request restates the identical stack inside the summary card on `#fbfaf7`, since
that is where the customer commits. **A qualified and an unqualified state must never share one line
list** — the prototype gives each its own basket for exactly this reason.

### The arithmetic
Order of operations, which the prototype implements and the app must match:

```
line total      = unit price × quantity
line reduced    = round(line total × (100 − book percentage)) / 100
full price      = Σ line total
after sale      = Σ line reduced
sale saving     = full price − after sale
qualifies       = after sale ≥ threshold        ← tested AFTER the sale, not before
order discount  = qualifies ? round(after sale × order %) / 100 : 0
subtotal        = after sale − order discount
you save        = sale saving + order discount
short by        = threshold − after sale        ← drives the prompt copy
```

Rounding is per line and per discount, to the penny. Postage is still added later, by hand, when the
owner replies.

### A catalogue full of sale items (5e)
The sale page and any filtered grid where most cards carry a badge. Drawn at five-across with
15 cards, sale and non-sale mixed.

The badge survives that density because it is small, one colour, always the same corner, and carries
a **number that differs per card** — so a wall of them reads as information, not decoration. Two
supporting decisions:
- A **"Biggest saving first"** sort option is added, first in the list on this view.
- The "On sale" filter appears as an active navy chip like any other filter.

Noted on the page itself: when the filter *is* "On sale", the reduction is the premise and the page
could reasonably drop the badge and rely on the struck price alone. **The badge is kept** because
customers arrive from the home row expecting that same marker. Flag it if you disagree — it is a
one-line change.

### Constraints (all enforced in the drawings)
- **No countdown timers, no end dates, no "ends soon"** anywhere. The shop does not know when a sale
  ends until the owner ends it.
- No fake scarcity language.
- Nothing implies a payment is taken on the site. It still is not.

---

## Brief B — Running a sale, as the owner sees it

A new portal page at **`/admin/sales`**, modelled on Shelves: a named thing with members and an
order. It takes a sixth slot in the portal nav, between Shelves and Settings.

### The list (6a)
Header "Sales" with "1 live, 2 drafts, 3 ended" and a **New sale** pill. Beneath it, one paragraph
stating the rules in the owner's language — one at a time, per-book percentages, the headline is
worked out, putting a draft live ends the running one.

- **The live sale** is a full-width card with a **3px `#2f6b46` left rule**, a "Live now" chip, the
  date it started, its name at Spectral 600 24px, and a fact line: *"18 books · **up to 20% off** ·
  5% to 20% each · £41.20 given away so far across 9 orders."* Actions: Edit books · Preview ·
  **End sale** (`#9a3412` outline).
- **Drafts** — compact rows with a "Draft" chip, Edit, and a navy **Put live** pill.
- **Ended** — quieter rows in `#6f7787`, each keeping **what it gave away** in brass, and a
  **"Copy to a new sale"** link. Ended sales are kept with their books and percentages; that is the
  cheapest way for the owner to run last year's sale again.

### Adding books and setting a percentage each (6b)
**This is the screen that matters** — a search-and-tick over 225 titles with a number against each.

Two columns: the picker, and a 330px sticky sidebar.

**The picker's control bar** (on `#faf9f6`, above the table):
- A search pill with a live "7 of 225" count, searching title and Arabic title.
- A **Shelf** select, and an **"Only ones in the sale"** checkbox — the two ways an owner actually
  narrows 225 books.
- A second line: "3 ticked", then **"Set all ticked to [15] %"** with an Apply button, and
  **"Add whole shelf…"** on the right. Bulk-setting is the difference between this screen taking one
  minute and twenty.

**The table** is a six-column grid: checkbox · 44px thumb · title + shelf · full price ·
**percentage field** · **what they pay**.
- The percentage field is a small bordered shell with the `%` suffix inside it, right-aligned
  tabular numerals.
- "They pay" recalculates as you type — brass when the book is in the sale.
- **A blank or 0 percentage means the book is not in the sale**, and that row reads
  *"not in the sale"* in `#6f7787` with a plain white field. This is stated in the table footer too.
- Ticked rows carry a faint `rgba(24,68,133,.03)` wash.

**The sidebar** carries the one thing the owner cannot control directly:
- "In this sale · 18 books".
- **"Headline, worked out for you" → "Up to 20% off"** in `#9a3412` 22px, with the reason beneath:
  *"The largest percentage in the sale. You cannot type this — change a book's number and it
  follows."*
- Smallest / largest percentage, full price of all members, and the reduced total.
- A **3px `#8a6714`** note when members are out of stock: they stay in the sale and show the reduced
  price, but nobody can buy them until stock arrives.

Footer: *"Changes apply the moment you save — this sale is live."* and one **Save changes**.

### Creating one (6c)
Deliberately almost empty: a **name** (stated as customer-facing — it becomes the home page heading),
an optional line beneath it, and **"Create and add books"**. Plus one clarifying sentence:
*"No dates. A sale runs from when you put it live until you end it."*

### Preview (6c)
A navy preview bar reading *"Not visible to anyone yet. This is the home page row as it would
appear."* with a link to preview the sale page too. Beneath it, the real home row at reduced scale —
same heading, calculated headline pill, five cards, badges, struck prices.

### Going live (6c)
The confirmation **names what it costs**, because putting a draft live ends the running sale:

> **Put "Ramadan Sale" live?**
> Only one sale runs at a time, so this **ends "Back to School Sale" straight away** — its 18 books
> go back to full price. Then 24 books drop by 5% to 25%, and the shop starts showing "up to 25%
> off".

Below, a three-part fact strip: **Ending** (name + count) · **Starting** (name + count + headline) ·
**Baskets already made** → *"Repriced when the request is sent"*. Buttons: **Put it live** / Not yet.
`3px #8a6714` left rule — waiting on a decision.

### Ending one (6c)
`3px #9a3412` left rule. States all four consequences: books return to full price, the row
disappears from the home page, the sale is kept so it can be copied later, and **orders already sent
keep the prices they were quoted**.

### The order discount — in Settings, not here (6c)
It runs all the time, so it is not a sale. It belongs in **Settings › Orders**, drawn as the last
card in 6c: an on/off toggle, **"Once the order reaches £85.00"**, **"Take off 10%"**, and a preview
strip showing the customer-facing sentence it generates: *"Spend £12 more and 10% comes off"*.
One explanatory line says why it lives there rather than with the sales.

---

## Brief C — Find a cover (7a)

Small, four states, on the Photos section of a listing with no photo.

1. **No photo — two equal doors.** Section heading with a `#9a3412` "None yet" chip, one sentence of
   why it matters, then **two side-by-side cards of identical size**: *Find a cover* (magnifier icon,
   filled navy button) and *Upload one myself* (upload icon, navy outline button, *"A photo of the
   book on your desk is often the best one there is"*). **Uploading is not a fallback in small
   print** — it is the same size, in the same row, with its own reason to exist.
2. **Candidates.** "6 possible covers", stating what it searched for (title *and* Arabic title), and
   a "Search again with different words" link. Six 3:4 thumbnails in a six-column grid, each with
   dimensions and source beneath. Unusable ones carry a `rgba(154,52,18,.92)` caption over the
   bottom of the image — *"small — may look soft"*, *"would crop badly"* — judged the same way
   `cropsCleanly()` already judges uploads. The first is ringed `#184485`. Footer repeats
   **"Upload one myself"** as an equal outline option.
3. **Nothing found.** *"Nothing came back"*, and the empty state does the important work of saying
   this is normal: *"Older prints and local editions often have no photo anywhere — this is normal
   and not a fault in the listing."* Two actions of equal weight — Upload one myself (filled) and
   Try different words — plus an editable search-words field with the hint that adding the publisher
   sometimes helps.
4. **Chosen.** Hands straight into **the cover-review dialog that already exists** — full size, the
   crop check, keep or discard. Stated on screen: nothing is attached until you accept it, and
   nothing is saved until you save the form.

---

## Design Tokens
All from `src/styles/global.css`. Nothing new is introduced.

| Token | Value | Used for |
|---|---|---|
| navy | `#184485` | primary actions, links |
| navy-deep | `#0e2a55` | portal header, preview bar, display headings |
| paper-raised | `#fbfaf7` | page ground, field fill, summary strip |
| card | `#ffffff` | panels |
| rule-soft | `#e6e2d9` | card borders, hairlines |
| rule | `#ddd9d1` | field borders, outline pills |
| ink | `#101828` · ink-soft `#4a5568` · ink-faint `#6f7787` | text · **struck old price** |
| **brass** | `#8a6714` | **the price, and only the price** · waiting-on-a-decision left rules |
| instock | `#2f6b46` | "You save …", live sale, crops cleanly |
| outstock | `#9a3412` | sale badge, discount rows, destructive, unusable candidate |

**Left rules keep their meaning:** `#9a3412` irreversible · `#8a6714` waiting on someone or something
· `#2f6b46` live or done.

Type: Spectral 400/500/600 display · IBM Plex Sans 400/500/600 UI · Noto Naskh Arabic for `.ar`.
All money is `font-variant-numeric: tabular-nums`.
Radii: 999px pills, 12px panels, 10px insets, 8px fields, 2px covers and classmarks.
Portal content max-width 1100px, shop 1160px.

## Not covered
About, Contact, the four policy pages, 404, the order lookup form, admin sign-in, the single-order
view, the owner's side of a cancellation request, the reservation confirmation email, and a
per-sale takings report beyond the one figure shown on 6a.
