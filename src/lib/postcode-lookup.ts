/**
 * Turning a UK postcode into a town and a county.
 *
 * postcodes.io, which is Ordnance Survey open data served free with no account,
 * no API key and no cost. It is not a tracker and it is not told who is asking
 * - only a postcode goes out, which is why it does not change the site's
 * position on cookies and consent.
 *
 * What it deliberately does **not** do is give the house number and street.
 * That is the Royal Mail Postcode Address File, which is licensed and paid for,
 * and no free source has it. The customer still types their own street. If a
 * paid provider is bought later, this is the one file that changes.
 *
 * Everything here is a convenience. A failure - offline, rate-limited, an
 * unknown postcode, a slow reply - is silent and changes nothing, because a
 * lookup that blocks an order is worse than no lookup at all.
 */

const ENDPOINT = 'https://api.postcodes.io/postcodes/';

export interface PostcodePlace {
  /** The town, for the "Town or city" box. */
  city: string;
  /** The county, for the "County" box. May be empty - many places have none. */
  region: string;
  /** The postcode as the Post Office writes it, e.g. `M1 4WB`. */
  postcode: string;
}

/**
 * Tidy a postcode without asking anybody.
 *
 * `m14wb` becomes `M1 4WB`. The space always goes before the last three
 * characters, which is the rule for every UK postcode regardless of the length
 * of the outward code. Anything that is not a plausible length is handed back
 * only uppercased, since guessing where to break it would make it worse.
 */
export function tidyPostcode(raw: string): string {
  const bare = raw.toUpperCase().replace(/\s+/g, '');
  if (bare.length < 5 || bare.length > 7) return raw.trim().toUpperCase();
  return `${bare.slice(0, -3)} ${bare.slice(-3)}`;
}

/** Worth a lookup? Cheap shape check, so we do not call out on "M". */
export function looksLikePostcode(raw: string): boolean {
  return /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(raw.trim());
}

/**
 * The place a postcode is in, or null.
 *
 * Null for every kind of failure - there is nothing useful to tell a customer
 * about a lookup they did not ask for. `signal` lets a superseded request be
 * dropped when they keep typing.
 */
export async function lookupPostcode(
  postcode: string,
  signal?: AbortSignal,
): Promise<PostcodePlace | null> {
  if (!looksLikePostcode(postcode)) return null;

  try {
    const res = await fetch(ENDPOINT + encodeURIComponent(postcode.trim()), { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      result?: {
        postcode?: string;
        post_town?: string;
        admin_district?: string;
        admin_county?: string;
      };
    };
    const r = body.result;
    if (!r) return null;

    /*
     * `admin_county` is null across most of England, where county councils were
     * abolished and the district is the only county-like thing left. Falling
     * back to `admin_district` is what makes "Manchester" produce "Greater
     * Manchester" rather than an empty box.
     */
    return {
      city: r.post_town ?? r.admin_district ?? '',
      region: r.admin_county ?? '',
      postcode: r.postcode ?? tidyPostcode(postcode),
    };
  } catch {
    return null; // aborted, offline, blocked, or malformed - all the same here
  }
}
