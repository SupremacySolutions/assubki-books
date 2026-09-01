# The 18 blanks to fill in

Every specific the shop must supply is marked as a blank on the four policy
pages rather than invented. A made-up returns address is worse than an empty
one, so nothing here was guessed.

Each blank is a `<span class="blank">` in the page source. Replace the bracketed
text with the real answer and delete the surrounding span, so
`<span class="blank">[address]</span>` becomes just the address.

---

## `/privacy` — `src/pages/privacy.astro` (5)

| Blank | What it is asking |
|---|---|
| `[how long — six years is usual for UK tax records]` | How long order records are kept |
| `[the email address to use]` | Where someone writes to ask for a copy of their data, or its deletion |
| `[trading name and, if registered, company number]` | Who runs the shop |
| `[address]` | The shop's address |
| `[date]` | When the policy was last updated |

## `/returns` — `src/pages/returns.astro` (3)

| Blank | What it is asking |
|---|---|
| `[the email address to use]` | Where a customer tells you they are cancelling |
| `[you or us — say which]` | Who pays return postage |
| `[the return address]` | Where books are sent back to |

## `/delivery` — `src/pages/delivery.astro` (6)

| Blank | What it is asking |
|---|---|
| `[usual range, e.g. £3.50–£6]` | Typical UK postage |
| `[carriers you use]` | Who you post with |
| `[e.g. 24 hours]` | How quickly orders are usually confirmed |
| `[e.g. 2 working days]` | How quickly they are posted after payment |
| `[e.g. 2–3 working days]` | How long delivery then takes |
| `[Say whether duties are the customer's responsibility, and any countries you do not post to.]` | The overseas position |

## `/terms` — `src/pages/terms.astro` (4)

| Blank | What it is asking |
|---|---|
| `[Trading name, and company number if registered]` | Trading identity |
| `[address]` | Trading address |
| `[email]` | Contact address |
| `[England and Wales, or as applicable]` | Which law governs the terms |

---

**This is not legal advice and the wording is worth having checked.** The gap
itself is not in doubt: `orders` holds names, emails, phone numbers, delivery
addresses, Telegram chat ids and a purchase history, and a shop holding that
needs these four pages. What is written is a reasonable starting point, not a
substitute for someone who does this for a living.

**No cookie banner is needed** and none was added. The only things this site
puts on a visitor's device are the basket, the group-basket name and the
owner's admin session — all strictly necessary for a service the customer
asked for, which is exempt from consent under PECR. There is not one
third-party tracker in the codebase.
