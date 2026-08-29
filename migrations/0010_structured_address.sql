-- An address good enough to put on a parcel going anywhere.
--
-- It used to be one free-text box, checked only for being eight characters
-- long. That is not an address, it is a hope - and the shop posts abroad, where
-- a missing postcode or an unnamed country is the difference between a delivery
-- and a return.
--
-- `orders.address` stays, and still holds the formatted block: every page,
-- email and portal view goes on reading it exactly as before. These columns sit
-- underneath it, so a courier label or a customs form has real fields to draw
-- on rather than a paragraph to guess at.
--
-- All nullable. Orders already placed have no parts and must not become
-- invalid retrospectively.

ALTER TABLE orders ADD COLUMN address_line1 TEXT;
ALTER TABLE orders ADD COLUMN address_line2 TEXT;
ALTER TABLE orders ADD COLUMN address_city TEXT;
ALTER TABLE orders ADD COLUMN address_region TEXT;
ALTER TABLE orders ADD COLUMN address_postcode TEXT;
-- ISO 3166-1 alpha-2, or 'OTHER' when the customer's country is not listed.
ALTER TABLE orders ADD COLUMN address_country TEXT;
