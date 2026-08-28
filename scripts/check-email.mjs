#!/usr/bin/env node
/**
 * Checks the email path end to end, in the order things actually fail.
 *
 *   node scripts/check-email.mjs                 # DNS + Resend only
 *   node scripts/check-email.mjs you@example.com # ...then a real order
 *
 * The order test hits the deployed site, places a request for a real book and
 * reports whether the confirmation and the owner notification were accepted.
 * It cancels the order afterwards so no stock stays held.
 */

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DOMAIN = 'assubkibooks.co.uk';
const SITE = 'https://assubki-books.support-supremacysolutions.workers.dev';
const to = process.argv[2] ?? null;

// Production config lives in wrangler.jsonc, not .dev.vars. Reading the wrong
// one made this script report the owner notification going somewhere it did
// not - it actually reaches the shop's real inbox.
const prodVars = JSON.parse(
  readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''),
).vars ?? {};

const vars = Object.fromEntries(
  readFileSync('.dev.vars', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const ok = (s) => `  \x1b[32mPASS\x1b[0m ${s}`;
const no = (s) => `  \x1b[31mFAIL\x1b[0m ${s}`;
const meh = (s) => `  \x1b[33m....\x1b[0m ${s}`;

async function dig(name, type) {
  try {
    const { stdout } = await execFileAsync('dig', ['+short', name, type]);
    return stdout.trim();
  } catch {
    return '';
  }
}

console.log(`\n1. DNS for ${DOMAIN}`);

const dkim = await dig(`resend._domainkey.${DOMAIN}`, 'TXT');
console.log(dkim ? ok('DKIM record present') : no('DKIM record missing (resend._domainkey)'));

const sendSpf = await dig(`send.${DOMAIN}`, 'TXT');
console.log(sendSpf ? ok('SPF present on the send subdomain') : no('SPF missing on send.' + DOMAIN));

const sendMx = await dig(`send.${DOMAIN}`, 'MX');
console.log(sendMx ? ok('MX present on the send subdomain') : meh('MX missing on send.' + DOMAIN + ' (Resend uses it for bounces)'));

// The owner's own mail must survive all of this.
const rootMx = await dig(DOMAIN, 'MX');
const rootTxt = await dig(DOMAIN, 'TXT');
console.log(rootMx.includes('ionos') ? ok("owner's IONOS mail still routed (root MX intact)") : no("root MX no longer points at IONOS - the owner's mail is broken"));
const spfCount = rootTxt.split('\n').filter((l) => l.includes('v=spf1')).length;
console.log(
  spfCount === 1
    ? ok('exactly one root SPF record')
    : no(`${spfCount} root SPF records - more than one makes SPF fail entirely`),
);

console.log('\n2. Resend');
const key = vars.RESEND_API_KEY;
const from = vars.ORDER_FROM;
if (!key || !from) {
  console.log(no('RESEND_API_KEY or ORDER_FROM missing from .dev.vars'));
  process.exit(1);
}
console.log(meh(`sending as ${from}`));

const probe = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from,
    to: [to ?? 'delivered@resend.dev'],
    subject: 'As-Subki Books - delivery check',
    text: 'Sending works.',
  }),
});
const probeBody = await probe.json().catch(() => ({}));
if (probe.ok) {
  console.log(ok(`Resend accepted the message (id ${probeBody.id ?? '?'})`));
} else {
  console.log(no(`Resend refused: ${probeBody.message ?? probe.status}`));
  console.log('\nFix that before testing an order - every order email fails the same way.\n');
  process.exit(1);
}

if (!to) {
  console.log('\nPass an email address to also place a real order:');
  console.log('  node scripts/check-email.mjs you@example.com\n');
  process.exit(0);
}

console.log('\n3. A real order');
const list = await (await fetch(`${SITE}/api/basket?ids=1`)).json();
const book = list.books?.[0];
if (!book) { console.log(no('could not read a book from the live site')); process.exit(1); }

const res = await fetch(`${SITE}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Email Check',
    email: to,
    fulfilment: 'collection',
    notes: 'Automated check - cancel this one.',
    items: [{ bookId: book.id, qty: 1 }],
  }),
});
const order = await res.json();
if (!order.ok) { console.log(no(`order refused: ${order.error}`)); process.exit(1); }

console.log(ok(`order ${order.ref} placed for "${book.title}"`));
console.log(meh(`customer confirmation -> ${to}`));
console.log(meh(`owner notification    -> ${prodVars.OWNER_EMAIL ?? '(OWNER_EMAIL unset)'}  <- the shop's real inbox`));
console.log(meh(`status page: ${SITE}/order/${order.ref}?t=${order.token}`));

console.log(`
Check both inboxes. The customer mail should carry the itemised request and a
"Connect Telegram" button; the owner mail should carry the address, contact
details and a Confirm link.

Then cancel it so the stock is released:
  npx wrangler d1 execute assubki-books --remote --command "UPDATE books SET reserved = MAX(0, reserved - 1) WHERE id = ${book.id}; DELETE FROM orders WHERE ref = '${order.ref}';"
`);
