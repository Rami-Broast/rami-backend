import { DeliveryStatus } from '@prisma/client';

import { canCallCustomer } from '../../src/delivery/customer-contact';

/**
 * The gate on an unmasked personal phone number, so it is checked by something
 * other than reading the delivery service.
 */
describe('canCallCustomer', () => {
  it('withholds the number from a driver who has only been assigned the job', () => {
    // Nothing to ring anyone about yet, and the food is still at the branch.
    expect(canCallCustomer(DeliveryStatus.ASSIGNED)).toBe(false);
    expect(canCallCustomer(DeliveryStatus.PENDING_ASSIGNMENT)).toBe(false);
  });

  it('opens at pickup, not at out-for-delivery', () => {
    // The delivery machine allows PICKED_UP → DELIVERED directly, so gating on
    // OUT_FOR_DELIVERY would make the driver who never pressed "Start
    // delivery" — most of them, on a short hop — the one person unable to call,
    // at exactly the door where they needed to.
    expect(canCallCustomer(DeliveryStatus.PICKED_UP)).toBe(true);
    expect(canCallCustomer(DeliveryStatus.OUT_FOR_DELIVERY)).toBe(true);
  });

  it('takes it away the moment the job closes, successful or not', () => {
    // The boundary that matters most. A finished delivery still *lives* in the
    // driver app — Home lists past jobs under "OTHER" and every row opens the
    // delivery screen — so keeping the number past the drop would not have
    // meant a few minutes of grace. It would have meant every customer a driver
    // had ever delivered to staying one tap from being dialled, for as long as
    // the app was installed.
    expect(canCallCustomer(DeliveryStatus.DELIVERED)).toBe(false);
    expect(canCallCustomer(DeliveryStatus.FAILED)).toBe(false);
  });

  it('gives nothing away on a cancelled delivery', () => {
    // Cancelled before pickup — the driver never carried it and has no business
    // holding the number.
    expect(canCallCustomer(DeliveryStatus.CANCELLED)).toBe(false);
  });

  it('opens for exactly the two statuses a delivery is live in, and no others', () => {
    // Stated as a whole rather than status by status, so widening the gate has
    // to be a deliberate edit to this list — not something that falls out of
    // adding a status somewhere else.
    const open = Object.values(DeliveryStatus).filter((s) => canCallCustomer(s));
    expect(open.sort()).toEqual([DeliveryStatus.OUT_FOR_DELIVERY, DeliveryStatus.PICKED_UP].sort());
  });

  it('has an answer for every status the schema defines', () => {
    // A status added later must be a deliberate decision here, not an
    // accidental `undefined` that reads as false — or, worse, as true.
    for (const status of Object.values(DeliveryStatus)) {
      expect(typeof canCallCustomer(status)).toBe('boolean');
    }
  });
});
