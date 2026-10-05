import { DeliveryStatus } from '@prisma/client';

/**
 * When a driver may see the customer's phone number.
 *
 * **Owner decision.** This platform previously never gave a driver a customer's
 * number at all: no call-masking provider is contracted, and the safe default
 * was to withhold it rather than invent a masking scheme. The owner has now
 * decided drivers should be able to ring the customer directly, unmasked, when
 * they arrive — a driver standing at an unmarked gate with a cooling bag and no
 * way to reach anyone is the failure that decision is answering.
 *
 * What is *not* being given up is that it stays as narrow as the decision
 * allows. Three limits, all enforced server-side:
 *
 *  1. **Only the assigned driver.** Enforced by `DeliveryService.loadOwn`,
 *     which resolves the delivery by the calling driver's own id — an unowned
 *     delivery returns the same 404 as one that does not exist.
 *  2. **Only while the delivery is live.** A driver who has merely been
 *     assigned a job has no reason to ring anyone, and one who has finished has
 *     no reason to ring them again — the number appears at pickup and is gone
 *     the moment the job closes, so nothing accumulates on the handset.
 *  3. **Never anywhere else.** The staff delivery view is unchanged, and the
 *     number is stripped from the payload entirely — not merely hidden by the
 *     app — when the gate is closed, so it cannot be read out of a response a
 *     screen chose not to render.
 *
 * Pure, so the gate is testable without a database and cannot drift as statuses
 * are added.
 */

/**
 * Statuses from which the assigned driver may call the customer.
 *
 * **While the delivery is in their hands, and not one moment longer.**
 *
 * `PICKED_UP` rather than `OUT_FOR_DELIVERY` at the near end, deliberately: the
 * delivery machine allows `PICKED_UP → DELIVERED` directly, so a driver who
 * never pressed "Start delivery" — most of them, on a short hop — would
 * otherwise be the one person who could not call, at exactly the door where
 * they needed to.
 *
 * `DELIVERED` and `FAILED` are **excluded**, and that boundary is the whole
 * point rather than a detail. A first draft kept them, reasoning that the call
 * a driver most needs is sometimes the one after a failed drop. What that
 * missed is where a finished delivery still *lives*: the driver app's Home
 * screen lists past jobs under "OTHER" and every one of them opens the delivery
 * screen. Keeping the number past the drop therefore did not mean "a few
 * minutes of grace" — it meant every customer a driver had ever delivered to
 * stayed one tap from being dialled, for as long as the app was installed. That
 * is a standing directory of customers' personal numbers on a courier's
 * handset, which is a different thing from what was asked for and a different
 * thing from what the privacy notice now describes.
 *
 * The after-the-fact call is not actually lost: a driver rings the customer
 * *before* pressing Failed, which is the order those two things happen in
 * anyway. What is lost is the ability to ring them next week, and that is the
 * intent.
 */
const CONTACTABLE_STATUSES: readonly DeliveryStatus[] = [
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.OUT_FOR_DELIVERY,
];

export function canCallCustomer(status: DeliveryStatus): boolean {
  return CONTACTABLE_STATUSES.includes(status);
}
