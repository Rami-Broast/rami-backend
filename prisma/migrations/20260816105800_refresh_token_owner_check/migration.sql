-- A refresh token belongs to exactly one actor: a staff user OR a customer,
-- never both and never neither.
--
-- Prisma cannot express a CHECK constraint, so it is added here directly. The
-- application also validates this, but an application check is not a guarantee
-- — this makes the invariant impossible to violate, including from a migration,
-- a script, or a psql session.
ALTER TABLE "RefreshToken"
  ADD CONSTRAINT "RefreshToken_exactly_one_owner"
  CHECK (("userId" IS NOT NULL) <> ("customerId" IS NOT NULL));
