# Every message the shop sends

Read this to change what customers are told. Each entry says what sets it off,
who receives it, which channels carry it, and the exact words — including every
variant, because most of this copy changes shape depending on the order.

**How to use it:** edit the wording here, and it gets applied to the code. Almost
all of it lives in two files: `src/lib/notify.ts` (the emails and their Telegram
twins) and `src/lib/order-status.ts` (the status copy, shared between the emails
and the customer's order page — change one without the other and they drift).

Values in `{braces}` are filled in per order.

---

## The letterhead, on every email

A navy band with the shop's mark, `As-Subkī Books`, and `مكتبة السبكي` beneath
it, then the heading and sub-heading listed for each message below. Every email
ends with a centred link to `assubkibooks.co.uk`.

All customer email is sent from the shop's sending address with **reply-to set to
the address the owner actually reads**, so a customer hitting reply reaches a
person.

---

# 1. The customer places an order

Three messages go out at once: one to the customer, two to the owner.

## 1a. Customer — "Request received"

**Channels:** email (HTML and plain text). Not Telegram — no chat is linked yet.

**Subject:** `Your request {ref} - As-Subkī Books`
**Heading:** `Request received` · **Sub:** `Reference {ref}`

> Assalamu alaikum {name},
>
> Thank you - we have your request and these books are held for you. **We will
> reply with the total including postage and how to pay.**

Then the list of books and the subtotal, then:

| Order type | Line |
|---|---|
| Collection | `For collection.` |
| Delivery | `To be posted to:` followed by the address |

If they left a note: `Your note: {notes}`

**The Telegram invitation** — only when the bot is set up and this customer has
not already linked a chat:

> **Get your payment details on Telegram**
>
> Tap once to connect this order to your Telegram. We will send the total and how
> to pay straight to your chat.
>
> [Connect Telegram]

Then a button, `View your request`, and finally:

> We hold these copies until {expires}. If we have not heard from you by then the
> hold lapses and the books return to the shelf - nothing is charged and there is
> nothing to cancel. No payment is taken on our website at any point.

> **Worth a look:** `{expires}` currently prints as a raw UTC string —
> `Fri, 29 Aug 2026 14:03:00 GMT`. Everywhere else on the site uses a friendlier
> format.

## 1b. Owner — "New request"

**Channels:** email. Reply-to is set to the customer, so replying reaches them.

**Subject:** `New request {ref} - {name}`
**Heading:** `New request {ref}` · **Sub:** `{n} book(s) · {£subtotal}`

The customer's name, email and phone, the books and subtotal, then `Collection` /
`Customer is collecting in person.` or `Deliver to` and the address; the note if
there is one; a button `Confirm and send payment details`; and:

> Stock is held for 48 hours from now, then released automatically.

## 1c. Owner — Telegram alert

Only when the owner has bound their chat to the bot.

```
*New order {ref}*

{name} · {£subtotal}
{title} x{qty}

Open order: {link to the order in the portal}
```

---

# 2. The owner confirms and sends payment details

**Recipient:** customer. **Channels: email and Telegram** — both, when their chat
is linked. If neither can be delivered the order is put back in the queue and
nothing is sent, so an order can never appear handled when the customer was
never told.

The body of the payment instructions is whatever the owner types on the order.
Left blank it falls back to a draft from Settings — one for posted orders, one
for collections — except for a cash collection, which uses this fixed line:

> No payment is needed now. Your books are set aside - message us to agree a
> time, and you can pay in cash when you collect.

### Email

| | Paying now | Cash on collection |
|---|---|---|
| **Subject** | `Order {ref} confirmed - {£total} to pay` | `Order {ref} confirmed - {£total} on collection` |
| **Sub** | `Reference {ref} · {£total} to pay` | `Reference {ref} · {£total}` |
| **Opening** | `Your books are reserved. Here is the total and how to pay.` | `Your books are set aside. Here is what they come to - you can pay in cash when you collect.` |
| **Total row** | `Total to pay` | `Total, payable on collection` |
| **Panel heading** | `How to pay` | `Collecting your books` |
| **Closing the panel** | `Please quote {ref} with your payment.` | `Quote {ref} when you collect.` |
| **Footer** | `Once your payment reaches us we will confirm and post your books.` | `No payment is taken on our website. Message us to agree a time and the books will be waiting.` |

Postage appears as its own row only on a delivery. The button reads
`View your order`.

### Telegram

The same figures and the same payment text, as a message headed
`*Order {ref} confirmed*`, ending in the same quote line.

---

# 3. Status changes

Each of these goes to the customer by **email and Telegram**. Every one is
wrapped the same way: `Assalamu alaikum {name},` then the line below, then a
`View your order` button.

## Payment received / ready

| Order type | Subject | Line |
|---|---|---|
| Cash collection, address set | `Ready to collect - {ref}` | `Your books are set aside for you at {address}. Get in touch to arrange a time - you can pay when you collect.` |
| Cash collection, no address | `Ready to collect - {ref}` | `Your books are set aside for you. Get in touch to arrange a time - you can pay when you collect.` |
| Prepaid collection, address set | `Ready to collect - {ref}` | `We have received your payment. Your books are set aside for you at {address}.` |
| Prepaid collection, no address | `Ready to collect - {ref}` | `We have received your payment. Your books are set aside, ready whenever suits you.` |
| Delivery | `Payment received - {ref}` | `We have received your payment. Your books are being packed.` |

`{address}` is the shop's collection address from Settings.

## Posted

**Subject:** `Your books are on the way - {ref}`

| | Line |
|---|---|
| Tracking number and carrier | `Your order has been posted with {carrier}. Your tracking number is {tracking}.` |
| Tracking number, no carrier | `Your order has been posted. Your tracking number is {tracking}.` |
| No tracking number | `Your order has been posted. Thank you for your custom.` |

> **Worth a look:** the message quotes the number but carries no link. The
> clickable tracking link only exists on their order page.

## Complete

**Subject:** `Order complete - {ref}`

| Order type | Line |
|---|---|
| Collection | `Thank you for collecting your books, and for your custom.` |
| Delivery | `Your order is complete. Thank you for your custom.` |

## Cancelled

**Subject:** `Order cancelled - {ref}`
**Line:** `This request has been cancelled. Nothing was charged.`

---

# 4. The 48-hour hold lapsing

**Nothing is sent.** The order quietly becomes lapsed and the books go back on
the shelf. A customer who returns to their link sees:

> **Hold lapsed** — We did not hear back within 48 hours, so the books returned
> to the shelf. Nothing was charged - you are welcome to request again.

> **A decision to make:** should a lapsing hold warn the customer first — say, a
> few hours before it goes? Today the first they know is finding the page
> changed.

---

# 5. What the Telegram bot says

| When | Reply |
|---|---|
| They open the connect link from their order | `Assalamu alaikum {first name}.` / `This chat is now connected to order {ref}.` / `We will send your total and how to pay here as soon as the shop confirms it.` / `Once you have paid you can send a screenshot here and it will reach the shop.` |
| The owner opens their own connect link | `Connected. New orders and payment screenshots will be sent here.` |
| They message the bot with no link | `Assalamu alaikum. Open the link in your order confirmation and I will connect this chat to your order.` |
| The link is malformed | `That link was not recognised.` |
| The order behind the link cannot be found | `That order could not be found.` |
| They send a payment screenshot, and it reaches the shop | `Thank you. That has reached the shop and will be checked against {ref}.` |
| A screenshot fails to send | `Sorry, that did not get through. Please try sending it again shortly.` |
| A screenshot arrives but no owner chat is connected | `Thank you. Please send this to the shop directly - we cannot pass it on just yet.` |
| They send a sixth screenshot for one order | `We already have your screenshots for this order. The shop will be in touch.` |
| They say anything else, and a contact handle is set | `This bot only handles orders. For anything else, message {handle}.` |
| They say anything else, no handle set | `This bot only handles orders. The shop will be in touch about yours.` |

**The screenshot as it reaches the owner** carries this caption:

```
*Payment screenshot - {ref}*
{customer name}, {£amount} due
They said: {their caption}
```

---

# 6. Group baskets

**Recipient:** the organiser, when they start one. **Channel:** email only.

**Subject:** `Your group basket {code} - As-Subkī Books`
**Heading:** `Your group basket` · **Sub:** `Reference {code}`

> Assalamu alaikum {name},
>
> Your group basket is open. Send the first link to everyone adding to it; keep
> the second for yourself - it is the one that sends the order to us when the
> list is complete.
>
> **The link to share** — {link}
> **Your own link - keep this one** — {link}
>
> [Open your group basket]
>
> Nothing is held or charged while a group basket is being filled. The books are
> only set aside once you send it, and it lasts a week.

Sending a group basket produces an ordinary order, so everyone gets the messages
in section 1. The owner's copy carries the breakdown of who asked for what.

---

# 7. The channel listing

Posted to the Telegram channel when a book is published; editing the book edits
the same post.

```
*{title}*
{Arabic title}

{first 180 characters of the description}

*£{price}*
{n} available          ← or "out of stock"

Order here:
{link to the book}
```

---

# 8. The order page's own wording

Not sent anywhere, but the messages above are deliberately written to match it —
change one and the other should follow.

| Stage | Heading | Beneath it |
|---|---|---|
| Just placed | `Request received` | `Your books are held. We will reply with the total and how to pay.` |
| Awaiting payment | `Awaiting payment` | `We have sent you payment details. Your books stay held until payment reaches us.` |
| Cash collection, confirmed | `Ready to arrange collection` | `Your books are being set aside at {address}. Get in touch and we will agree a time - you can pay in cash when you collect.` |
| Ready, prepaid collection | `Ready to collect` | `Thank you. Your books are set aside for you at {address}.` |
| Ready, cash collection | `Ready to collect` | `Your books are ready at {address}. Contact us to arrange a collection time. Payment can be made when you collect.` |
| Paid, delivery | `Payment received` | `Thank you. Your order is being packed.` |
| Posted | `Posted` | `Your books are on their way.` |
| Delivered | `Delivered` | `Your order is complete. Thank you for your custom.` |
| Collected | `Collected` | `Your order is complete. Thank you for your custom.` |
| Cancelled | `Cancelled` | `This request was cancelled. Nothing was charged.` |
| Lapsed | `Hold lapsed` | `We did not hear back within 48 hours, so the books returned to the shelf. Nothing was charged - you are welcome to request again.` |

**The progress steps**, in order:

- `Request received` — `Your books were set aside for you.`
- `Confirmed, payment details sent` (a cash collection reads
  `Confirmed, collection to arrange`) — while waiting:
  `We are checking the books and working out the total.`
- Collection: `Ready to collect` — waiting, cash:
  `We will set them aside and agree a time with you.`; waiting, prepaid:
  `Once your payment reaches us your books will be set aside.`; done, cash:
  `Come and collect - you can pay when you arrive.`; done, prepaid:
  `Come and collect whenever suits you.`
- Collection: `Collected` — `We will mark this when you pick them up.`
- Delivery: `Payment received` — `Once your payment reaches us we will confirm here.`
- Delivery: `Posted` — `We will post your books and note it here.`
- Delivery: `Delivered` — `We will close this off once it reaches you.`
