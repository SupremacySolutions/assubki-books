/** Shared by the basket and checkout: a line is shelf stock or an incoming claim. */
export interface Purchasable {
  available: number;
  reservable?: number;
  shipmentId?: number | null;
}
export function planBasketLine(book: Purchasable, wanted: number) {
  const ceiling = Math.max(
    0,
    book.shipmentId != null
      ? (book.reservable ?? 0)
      : Math.max(book.available, book.reservable ?? 0),
  );
  const qty = Math.min(wanted, ceiling);
  const waiting = qty > 0 && (book.shipmentId != null || qty > book.available);
  return {
    qty,
    ceiling,
    waiting,
    parcel: waiting
      ? book.shipmentId != null
        ? `shipment:${book.shipmentId}`
        : 'incoming'
      : 'shelf',
  };
}
export function basketDeliveryNote(
  books: (Purchasable & { id: number })[],
  quantities: Record<string, number>,
): string {
  const plans = books
    .map((b) => planBasketLine(b, quantities[String(b.id)] ?? 0))
    .filter((p) => p.qty > 0);
  if (!plans.some((p) => p.waiting)) return '';
  const parcels = new Set(plans.map((p) => p.parcel)).size;
  return parcels > 1
    ? `Your basket becomes ${parcels} separate orders. In-stock books can be sent now; each delivery of reserved books follows when it arrives. Postage is quoted separately for each order. Nothing is paid for reserved books until they arrive.`
    : 'These books are reserved from an incoming delivery. Nothing is paid now; we contact you when all your copies have arrived.';
}
