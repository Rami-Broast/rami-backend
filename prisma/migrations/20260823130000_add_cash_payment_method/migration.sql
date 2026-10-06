-- Add the counter-cash payment method used by the Branch POS.
-- Recorded by staff at the point of sale; distinct from CASH_ON_DELIVERY,
-- which the driver collects at the door.
ALTER TYPE "PaymentMethod" ADD VALUE 'CASH';
