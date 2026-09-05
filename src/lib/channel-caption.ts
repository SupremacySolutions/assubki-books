/**
 * Deciding what a submitted channel post is worth storing.
 *
 * Shared because two routes take the same field: the listing save, which has
 * carried it since it was a note, and the channel post itself, which is where
 * it belongs now. Written once so the two cannot come to different answers
 * about the same box.
 */

/** Telegram's own caption limit. Refused here, where it can be seen. */
const CAPTION_MAX = 1024;

/**
 * The caption to store, or null to let the shop go on writing the post.
 *
 * Left alone is not the same as written. The box arrives filled in - it has to,
 * or the owner would be editing a blank instead of the post - so a caption
 * identical to the one offered means he never touched it, and storing that
 * would hand him a post frozen at today's price without his asking. An empty
 * box means the same thing said deliberately.
 *
 * Line endings are normalised because a textarea returns CRLF for the newlines
 * that went out as LF, which would otherwise make every untouched box look
 * edited.
 */
export function captionToStore(form: FormData): string | null {
  const lines = (value: string) => value.replace(/\r\n/g, '\n');
  const typed = lines(String(form.get('telegram_caption') ?? '').trim()).slice(0, CAPTION_MAX);
  const offered = lines(String(form.get('telegram_caption_generated') ?? '').trim());
  return !typed || typed === offered ? null : typed;
}
