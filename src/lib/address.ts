/**
 * Addresses, for anywhere.
 *
 * The shop posts abroad, and the checkout used to collect one free-text box
 * checked only for being eight characters long. Structured parts are what a
 * courier's label needs and what lets the form say which bit is missing.
 *
 * The parts are stored alongside the formatted block rather than instead of it:
 * every page and email that shows an address goes on reading `orders.address`,
 * and this is what writes it.
 */

export interface AddressParts {
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postcode?: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

/**
 * Where the shop's customers actually are, then everywhere else.
 *
 * A full list rather than a shortlist: postage is quoted per order anyway, so
 * an address the shop cannot serve is a conversation, not a form error - and a
 * customer who cannot even name their country has nowhere to go.
 */
export const COUNTRIES: { code: string; name: string }[] = [
  { code: 'GB', name: 'United Kingdom' },
  { code: 'IE', name: 'Ireland' },
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'IN', name: 'India' },
  { code: 'PK', name: 'Pakistan' },
  { code: 'BD', name: 'Bangladesh' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'TR', name: 'Türkiye' },
  { code: 'EG', name: 'Egypt' },
  { code: 'MA', name: 'Morocco' },
  { code: 'NG', name: 'Nigeria' },
  { code: 'KE', name: 'Kenya' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'BE', name: 'Belgium' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'DK', name: 'Denmark' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'AT', name: 'Austria' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'GR', name: 'Greece' },
  { code: 'QA', name: 'Qatar' },
  { code: 'KW', name: 'Kuwait' },
  { code: 'BH', name: 'Bahrain' },
  { code: 'OM', name: 'Oman' },
  { code: 'JO', name: 'Jordan' },
  { code: 'LB', name: 'Lebanon' },
  { code: 'SG', name: 'Singapore' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'JP', name: 'Japan' },
  { code: 'CN', name: 'China' },
  { code: 'BR', name: 'Brazil' },
  { code: 'MX', name: 'Mexico' },
  { code: 'AR', name: 'Argentina' },
  { code: 'GH', name: 'Ghana' },
  { code: 'TZ', name: 'Tanzania' },
  { code: 'UG', name: 'Uganda' },
  { code: 'SO', name: 'Somalia' },
  { code: 'SD', name: 'Sudan' },
  { code: 'DZ', name: 'Algeria' },
  { code: 'TN', name: 'Tunisia' },
  { code: 'LY', name: 'Libya' },
  { code: 'YE', name: 'Yemen' },
  { code: 'IQ', name: 'Iraq' },
  { code: 'AF', name: 'Afghanistan' },
  { code: 'LK', name: 'Sri Lanka' },
  { code: 'MV', name: 'Maldives' },
  { code: 'PH', name: 'Philippines' },
  { code: 'TH', name: 'Thailand' },
  { code: 'OTHER', name: 'Somewhere else' },
];

const NAMES = new Map(COUNTRIES.map((c) => [c.code, c.name]));

export const countryName = (code: string): string => NAMES.get(code) ?? code;
export const knownCountry = (code: string): boolean => NAMES.has(code);

/**
 * Countries that do not use postcodes at all.
 *
 * Demanding one would leave those customers with a required field their country
 * has no answer for - which is the sort of form that ends an order.
 */
const NO_POSTCODE = new Set([
  'AE', 'AO', 'AG', 'AW', 'BS', 'BZ', 'BJ', 'BO', 'BW', 'BF', 'BI', 'CM', 'CF',
  'KM', 'CG', 'CD', 'CK', 'CI', 'DJ', 'DM', 'GQ', 'ER', 'FJ', 'GM', 'GH', 'GD',
  'GY', 'HK', 'IE', 'JM', 'KE', 'KI', 'LY', 'MO', 'MW', 'ML', 'MR', 'MU', 'MS',
  'NR', 'NU', 'PA', 'QA', 'RW', 'KN', 'LC', 'ST', 'SC', 'SL', 'SB', 'SO', 'SR',
  'SY', 'TZ', 'TL', 'TK', 'TO', 'TT', 'TV', 'UG', 'VU', 'YE', 'ZW', 'OTHER',
]);

export const postcodeRequired = (country: string): boolean => !NO_POSTCODE.has(country);

/** UK postcodes are most of the shop's orders, so they get a real check. */
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

export function postcodeLooksWrong(country: string, postcode: string): boolean {
  if (country !== 'GB') return false; // every other format is somebody else's rule
  return !UK_POSTCODE.test(postcode.trim());
}

/**
 * What each field is called where the customer lives.
 *
 * Only the countries where the wrong word is actually jarring - a British
 * customer asked for a "state" and a "ZIP code" wonders whether the shop knows
 * where it is posting to.
 */
export function addressLabels(country: string): {
  city: string;
  region: string;
  postcode: string;
} {
  switch (country) {
    case 'GB':
      return { city: 'Town or city', region: 'County', postcode: 'Postcode' };
    case 'US':
      return { city: 'City', region: 'State', postcode: 'ZIP code' };
    case 'CA':
      return { city: 'City', region: 'Province', postcode: 'Postal code' };
    case 'AU':
    case 'NZ':
      return { city: 'Suburb or city', region: 'State', postcode: 'Postcode' };
    case 'IE':
      return { city: 'Town or city', region: 'County', postcode: 'Eircode' };
    default:
      return { city: 'City or town', region: 'Region or state', postcode: 'Postal code' };
  }
}

/**
 * The block that goes on the parcel, and into `orders.address`.
 *
 * The country is named unless it is the shop's own - a label reading "United
 * Kingdom" on a parcel posted within it is noise, and its absence on every
 * other address would be a mistake.
 */
export function formatAddress(parts: AddressParts): string {
  const lines = [
    parts.line1,
    parts.line2,
    parts.city,
    parts.region,
    parts.postcode,
    parts.country === 'GB' ? null : countryName(parts.country),
  ];
  return lines
    .map((l) => (l ?? '').trim())
    .filter(Boolean)
    .join('\n');
}
