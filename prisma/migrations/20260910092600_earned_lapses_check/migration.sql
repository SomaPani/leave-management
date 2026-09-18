-- The EARNED accrual's one invariant, as a constraint rather than a comment.
--
-- Every object is schema-qualified rather than relying on the `schema=orgapp`
-- parameter to set the search path — same rule as every migration before it.
--
-- Its own migration rather than the tail of 20260910091945_comp_off_claims,
-- which is where it belongs by subject: that migration adds 'EARNED' to the
-- LeaveAccrual enum, and Postgres refuses to use a new enum value inside the
-- transaction that added it ("New enum values must be committed before they
-- can be used"). The value has to be committed first, so the constraint that
-- names it needs a second migration.

-- An EARNED policy's credit is per-member and lapses at the year boundary:
-- carrying it would run the cap walk in balanceAsOf over credit that has no
-- schedule behind it, and `creditedInYear` has no answer for a year an EARNED
-- rule did not accrue in.
ALTER TABLE "orgapp"."LeavePolicy"
  ADD CONSTRAINT "LeavePolicy_earned_lapses"
  CHECK ("accrual" <> 'EARNED' OR "carry" = false);
