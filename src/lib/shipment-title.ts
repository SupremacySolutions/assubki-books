/**
 * What a shipment's title says about it, read apart.
 *
 * The owner names shipments the same way every time - "Pakistan Shipment First
 * Batch November 2026" - so where it comes from is the words before "shipment"
 * and the batch is what follows, less the month. Read here rather than kept in
 * a column of its own, so the list, the link card and the title can never say
 * three different things; a title without the word is all origin.
 *
 * Plain code with no server imports: the portal's card script uses it too.
 */
export function splitShipmentTitle(title: string): { origin: string; detail: string } {
  const match = title.match(/^(.*?)\bshipments?\b(.*)$/i);
  if (!match || !match[1].trim()) return { origin: title.trim(), detail: '' };
  const detail = match[2]
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b(\s*\/\s*\w+)?/gi, '')
    .replace(/\b20\d\d\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { origin: match[1].trim(), detail };
}
