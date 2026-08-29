/**
 * The checkout's rules, in one place.
 *
 * Both the page and the API import this, so what the customer is told before
 * they submit and what the server refuses afterwards cannot drift apart. The
 * server stays the authority - this module is pure so the browser can share it,
 * which means nothing here may touch `cloudflare:workers`.
 *
 * Each rule answers with the message the customer should read, or null.
 */

import {
  knownCountry,
  postcodeRequired,
  postcodeLooksWrong,
  addressLabels,
  type AddressParts,
} from './address';

export type Field =
  | 'name'
  | 'email'
  | 'phone'
  | 'fulfilment'
  | 'line1'
  | 'city'
  | 'region'
  | 'postcode'
  | 'country'
  | 'notes';

export interface Problem {
  field: Field;
  message: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const LIMITS = {
  name: 120,
  email: 254,
  phone: 40,
  line: 120,
  city: 80,
  region: 80,
  postcode: 24,
  notes: 2000,
} as const;

export const clean = (raw: unknown): string => String(raw ?? '').trim();

export function checkName(value: string): string | null {
  if (value.length < 2) return 'Enter your name.';
  if (value.length > LIMITS.name) return 'That name is too long.';
  return null;
}

export function checkEmail(value: string): string | null {
  if (!value) return 'Enter your email address.';
  if (value.length > LIMITS.email || !EMAIL_RE.test(value)) {
    return 'That email address does not look right.';
  }
  return null;
}

/**
 * Deliberately loose.
 *
 * This number is for a person to ring, not for a machine to parse, and the shop
 * posts abroad - a strict pattern would reject real numbers from countries
 * nobody thought about. Enough digits to be a phone number, few enough to be a
 * phone number, one optional `+`.
 */
export function checkPhone(value: string): string | null {
  if (!value) return 'Enter a phone number we can reach you on.';
  if (value.length > LIMITS.phone) return 'That number is too long.';
  if (!/^\+?[\d\s().-]+$/.test(value)) {
    return 'Use digits, spaces and an optional + only.';
  }
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return 'That does not look like a phone number.';
  return null;
}

export function checkFulfilment(value: string): string | null {
  return value === 'delivery' || value === 'collection'
    ? null
    : 'Choose whether we post the books or you collect them.';
}

export function checkNotes(value: string): string | null {
  return value.length > LIMITS.notes ? 'That note is too long.' : null;
}

/**
 * The address, as a list rather than one answer.
 *
 * Returned in the order the fields appear, so the page can mark every problem
 * at once and put the cursor in the first - being told about one missing field
 * at a time is how a form gets abandoned.
 */
export function checkAddress(parts: Partial<AddressParts>): Problem[] {
  const problems: Problem[] = [];
  const country = clean(parts.country);

  if (!country || !knownCountry(country)) {
    problems.push({ field: 'country', message: 'Choose the country we are posting to.' });
  }

  const line1 = clean(parts.line1);
  if (line1.length < 2) {
    problems.push({ field: 'line1', message: 'Enter the street address.' });
  } else if (line1.length > LIMITS.line) {
    problems.push({ field: 'line1', message: 'That line is too long.' });
  }

  const city = clean(parts.city);
  const labels = addressLabels(country);
  if (city.length < 2) {
    problems.push({ field: 'city', message: `Enter the ${labels.city.toLowerCase()}.` });
  } else if (city.length > LIMITS.city) {
    problems.push({ field: 'city', message: 'That is too long.' });
  }

  if (clean(parts.region).length > LIMITS.region) {
    problems.push({ field: 'region', message: 'That is too long.' });
  }

  const postcode = clean(parts.postcode);
  if (country && knownCountry(country) && postcodeRequired(country)) {
    if (!postcode) {
      problems.push({ field: 'postcode', message: `Enter the ${labels.postcode.toLowerCase()}.` });
    } else if (postcodeLooksWrong(country, postcode)) {
      problems.push({ field: 'postcode', message: 'That postcode does not look right.' });
    }
  }
  if (postcode.length > LIMITS.postcode) {
    problems.push({ field: 'postcode', message: 'That is too long.' });
  }

  return problems;
}

/** Everything, in the order the fields appear on the page. */
export function checkOrder(input: {
  name: string;
  email: string;
  phone: string;
  fulfilment: string;
  notes: string;
  address: Partial<AddressParts>;
}): Problem[] {
  const problems: Problem[] = [];
  const add = (field: Field, message: string | null) => {
    if (message) problems.push({ field, message });
  };

  add('name', checkName(input.name));
  add('email', checkEmail(input.email));
  add('phone', checkPhone(input.phone));
  add('fulfilment', checkFulfilment(input.fulfilment));
  if (input.fulfilment === 'delivery') problems.push(...checkAddress(input.address));
  add('notes', checkNotes(input.notes));

  return problems;
}
