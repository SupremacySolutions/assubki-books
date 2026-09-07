/**
 * Reading what a caller sent, without trusting them to have sent it.
 *
 * `request.formData()` does not return a verdict when the body is not what it
 * claims to be - it throws. Nothing caught it, so the throw travelled to the
 * top of the request and the shop answered a malformed body with 500 on
 * twenty-nine route/method pairs, sign-in and the customer's own message form
 * among them. A 500 says "this shop is broken"; the honest answer is "that is
 * not something I can read", and the difference matters to anybody watching
 * error rates for a real fault.
 *
 * Two shapes of wrong arrive here and both are the caller's:
 *
 *   - a body that does not parse - a truncated upload, a multipart boundary
 *     that does not match its header;
 *   - a body of the wrong type entirely - JSON posted to a form handler, which
 *     is what the audit's probe sent and what a mistaken integration sends.
 *
 * Neither is worth telling apart in the answer. `null` means "I could not read
 * this", and each route says so in the shape its own caller expects: a page
 * form gets its redirect, a fetch caller gets its JSON. That last part is why
 * this returns a value instead of throwing a tidy error of its own - there is
 * no one response that is right for both, and a helper that picked one would be
 * wrong half the time.
 */

/**
 * The submitted form, or `null` if the body was not a form.
 *
 * Covers `application/x-www-form-urlencoded` and `multipart/form-data`, which
 * between them are every form this site posts and every file it accepts.
 */
export async function readForm(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

/**
 * The submitted JSON object, or `null` if the body was not one.
 *
 * Deliberately narrower than `JSON.parse`: a bare `null`, a number or an array
 * all parse successfully and then fail at the first property read, which puts
 * the error back where it started. Callers here always send an object.
 */
export async function readJson<T = Record<string, unknown>>(
  request: Request,
): Promise<T | null> {
  try {
    const body = await request.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as T;
  } catch {
    return null;
  }
}

