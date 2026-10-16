-- How many emails the shop sent each day, for the Health page.
--
-- Resend's free plan allows 100 a day and 3,000 a month, and past either it
-- refuses every send until the limit resets - order confirmations, payment
-- details and arrival notices included. The shop's key can only send, so it
-- cannot ask Resend how much is left. It can count what it sends itself.
--
-- Keyed on the UTC day because that is when Resend's daily allowance resets.
-- `sent` counts what Resend accepted, `refused` counts what it turned away.
CREATE TABLE IF NOT EXISTS email_usage (
  day TEXT PRIMARY KEY,
  sent INTEGER NOT NULL DEFAULT 0,
  refused INTEGER NOT NULL DEFAULT 0
);
