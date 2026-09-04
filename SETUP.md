# Turning the connections on

Everything below is optional in the sense that the shop runs without it - orders
are taken, stock is held, and the portal works. Each connection unlocks an
extra service. Until messaging connections are set, the site logs what it would
have sent.

Set secrets from the repo root. They are per-environment and never committed:

```bash
npx wrangler secret put NAME
```

For local development put the same names in `.dev.vars` (already gitignored).

---

## 1. Email - Resend (free, 3,000/month)

Without this, customers get no confirmation and no payment details.

1. Sign up at resend.com and verify the sending domain.
2. Create an API key.

| Secret | Example | What it does |
|---|---|---|
| `RESEND_API_KEY` | `re_xxx` | Authorises sending |
| `ORDER_FROM` | `orders@assubkibooks.co.uk` | The From address - must be on the verified domain |
| `OWNER_EMAIL` | the shop's inbox | Where new order emails land |

Until the domain moves to Cloudflare, Resend can verify it at IONOS instead -
it needs its own DNS records either way.

## 2. Telegram bot

Two separate jobs: announcing listings in the channel, and DMing customers
their payment details.

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`. Keep the token.
2. Add the bot to the channel **as an administrator** with permission to post.
3. Get the channel id: forward any channel message to `@userinfobot`, or use
   `@channelusername` if it is public.

| Secret | Example |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `7712345678:AAH...` |
| `TELEGRAM_BOT_USERNAME` | `AsSubkiBooksBot` (no `@`) |
| `TELEGRAM_CHANNEL_ID` | `@alsubkibooks` or `-1001234567890` |
| `TELEGRAM_WEBHOOK_SECRET` | any long random string you invent |

Then point Telegram at the site - once, after deploying:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-domain>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

**Why the webhook matters.** A bot cannot start a conversation - Telegram only
lets it message someone who messaged it first. The customer taps *Connect
Telegram* on their order page, which opens the bot with their order reference,
and the webhook binds that chat to the order. Without the webhook registered,
nobody can ever be reached by DM and everything falls back to email.

`TELEGRAM_BOT_USERNAME` is what builds that link. Set it or the button never
appears.

## 3. Portal sign-in

Two ways in. The second retires the first automatically.

**Now - shared password.** Works immediately:

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ADMIN_SESSION_SECRET   # any long random string
```

**Better - Cloudflare Access.** Email one-time codes, no password to leak, and
you can revoke a person rather than rotating a shared secret:

1. Zero Trust dashboard → Access → Applications → **Add a self-hosted
   application**, domain `assubkibooks.co.uk`, path `admin`.
2. Add a policy allowing the owner's email address.
3. Copy the **Application Audience (AUD) tag**.

| Secret | Example |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `supremacy.cloudflareaccess.com` |
| `ACCESS_AUD` | the AUD tag |

The moment `ACCESS_AUD` is set, the password path stops working - deliberately,
so there are never two ways in. Delete `ADMIN_PASSWORD` afterwards.

## 4. Google Books cover lookup

Open Library works without configuration. A Google Books API key adds a second,
independent group of cover results in **Books → listing → Find a cover**.

1. In Google Cloud, create or choose a project.
2. Enable the **Books API**.
3. Create an API key restricted to the Books API.
4. Add it to the deployed Worker:

```bash
npx wrangler secret put GOOGLE_BOOKS_API_KEY
```

For local development, add `GOOGLE_BOOKS_API_KEY=...` to `.dev.vars`. Never put
the key in `wrangler.jsonc` or commit it. Deploy again after setting the secret.

The picker deliberately keeps Google results in their own labelled block,
preserves Google's relevance order, shows the official Powered by Google mark,
and links every result to Google Books. Those are product-branding requirements,
not decorative choices.

---

## Checking it worked

The portal's **Settings** page reports what is connected, and the **Dashboard**
warns about anything missing. Both read the live bindings, so they tell you the
truth about the deployed environment rather than what you meant to set.

A confirmed order that could not be delivered to anyone leaves the order in the
queue and says so, rather than marking it handled. If you see *"Nothing was
sent"*, email is not configured and that customer never connected Telegram.
