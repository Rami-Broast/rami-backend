import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TokenService } from '../auth/services/token.service';
import { Actor, ActorKind, isCustomer } from '../auth/types/actor';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';
import { UpdateProfileDto } from './dto/profile.dto';

/** The safe view of a customer's own profile. */
const profileView = {
  id: true,
  fullName: true,
  phone: true,
  email: true,
  createdAt: true,
} satisfies Prisma.CustomerSelect;

/** The safe view of an address returned to its owner. */
const addressView = {
  id: true,
  label: true,
  line1: true,
  line2: true,
  district: true,
  city: true,
  postalCode: true,
  latitude: true,
  longitude: true,
  notes: true,
  isDefault: true,
  createdAt: true,
} satisfies Prisma.CustomerAddressSelect;

/**
 * Customer addresses (Phase 9 backend surface).
 *
 * Enables delivery: an order needs a saved address, and this is where a
 * customer manages them. Every method is scoped to the caller's own customer
 * id — one customer can never read or change another's address, and a missing
 * or someone-else's id returns the same not-found so ids cannot be probed.
 */
/**
 * The placeholder that replaces a deleted customer's phone number.
 *
 * `Customer.phone` is `@unique`, so the real number has to be released or that
 * person could never sign up again — deleting an account must not be a
 * permanent ban. It is deliberately **not** in E.164 form: nothing a keypad can
 * produce can collide with it, and it can never be dialled by mistake from a
 * staff screen that still lists the row.
 */
export const deletedPhonePlaceholder = (customerId: string): string => `deleted:${customerId}`;

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  private customerId(actor: Actor): string {
    if (!isCustomer(actor)) {
      throw new ForbiddenException('Only a customer can manage their own account.');
    }
    return actor.id;
  }

  /** The caller's own profile. */
  async getProfile(actor: Actor) {
    const id = this.customerId(actor);
    const profile = await this.prisma.customer.findFirst({
      where: { id, deletedAt: null },
      select: profileView,
    });
    if (!profile) {
      throw new NotFoundException('Customer not found.');
    }
    return profile;
  }

  /** Updates the caller's own display name. Phone (the login identity) is view-only. */
  updateProfile(actor: Actor, dto: UpdateProfileDto) {
    const id = this.customerId(actor);
    return this.prisma.customer.update({
      where: { id },
      data: { fullName: dto.fullName },
      select: profileView,
    });
  }

  /**
   * Deletes the caller's own account — **by anonymising it, not by removing the
   * row**, and the distinction is not a shortcut.
   *
   * `Order.customerId` is `onDelete: Restrict`, as are `CouponUsage` and
   * `LoyaltyTransaction`. A customer who has ordered cannot be row-deleted, and
   * should not be: those orders are the restaurant's sales and VAT records and
   * it is required to retain them. Every report in `src/reports/` is built from
   * them, and their price snapshots must not change because somebody closed an
   * account.
   *
   * So what is erased is the personal data, and what remains is the commercial
   * record with nobody's name on it:
   *
   * - `fullName` and `email` cleared; `phone` replaced with a non-dialable,
   *   unique placeholder so the real number is **released** and that person can
   *   sign up again.
   * - Every address scrubbed of its text and its coordinates, then soft-deleted.
   *   The delivery address a driver used is snapshotted onto `Delivery` at READY
   *   (Phase 14), so an order keeps the address it was actually delivered to
   *   whatever happens here.
   * - `isActive` false and `deletedAt` set, which is what `ActorService` already
   *   filters on — a deleted customer cannot authenticate even with a live
   *   token.
   * - Every refresh-token family revoked, so existing sessions on other devices
   *   end rather than running until the token expires.
   *
   * Purging the anonymised row itself is a **retention decision nobody has
   * made** — it belongs to the restaurant's accountant against Saudi
   * tax-record rules, and it is not implemented here rather than guessed. See
   * `README.md`.
   */
  async deleteAccount(actor: Actor) {
    const customerId = this.customerId(actor);

    const existing = await this.prisma.customer.findFirst({
      where: { id: customerId, deletedAt: null },
      select: { id: true, phone: true },
    });
    if (!existing) {
      throw new NotFoundException('Customer not found.');
    }

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.customerAddress.updateMany({
        where: { customerId },
        data: {
          label: null,
          line1: '',
          line2: null,
          district: null,
          city: '',
          postalCode: null,
          latitude: null,
          longitude: null,
          notes: null,
          isDefault: false,
          deletedAt: now,
        },
      });

      // A challenge already in flight for the released number must not let the
      // next person to hold it walk into this account's sign-in.
      await tx.otpChallenge.updateMany({
        where: { phone: existing.phone, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
      });

      await tx.customer.update({
        where: { id: customerId },
        data: {
          fullName: null,
          email: null,
          phone: deletedPhonePlaceholder(customerId),
          isActive: false,
          deletedAt: now,
        },
      });
    });

    // Outside the transaction: the account is already unreachable without this,
    // and a revocation failure must not roll back the deletion the customer
    // asked for.
    await this.tokens.revokeAllForActor(
      { kind: ActorKind.Customer, id: customerId },
      'Customer deleted their account',
    );

    return { deleted: true };
  }

  list(actor: Actor) {
    return this.prisma.customerAddress.findMany({
      where: { customerId: this.customerId(actor), deletedAt: null },
      select: addressView,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async create(actor: Actor, dto: CreateAddressDto) {
    const customerId = this.customerId(actor);
    return this.prisma.$transaction(async (tx) => {
      const count = await tx.customerAddress.count({ where: { customerId, deletedAt: null } });
      // The first address is default; or an explicit request makes it default.
      const makeDefault = dto.isDefault === true || count === 0;
      if (makeDefault) {
        await tx.customerAddress.updateMany({
          where: { customerId, deletedAt: null },
          data: { isDefault: false },
        });
      }
      return tx.customerAddress.create({
        data: {
          customerId,
          label: dto.label,
          line1: dto.line1,
          line2: dto.line2,
          district: dto.district,
          city: dto.city,
          postalCode: dto.postalCode,
          latitude: dto.latitude,
          longitude: dto.longitude,
          notes: dto.notes,
          isDefault: makeDefault,
        },
        select: addressView,
      });
    });
  }

  async update(actor: Actor, id: string, dto: UpdateAddressDto) {
    const customerId = this.customerId(actor);
    await this.own(customerId, id);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true) {
        await tx.customerAddress.updateMany({
          where: { customerId, deletedAt: null },
          data: { isDefault: false },
        });
      }
      return tx.customerAddress.update({ where: { id }, data: { ...dto }, select: addressView });
    });
  }

  async remove(actor: Actor, id: string) {
    const customerId = this.customerId(actor);
    await this.own(customerId, id);
    await this.prisma.customerAddress.update({
      where: { id },
      data: { deletedAt: new Date(), isDefault: false },
    });
    return { id, deleted: true };
  }

  /** Asserts the address exists and belongs to this customer, or 404. */
  private async own(customerId: string, id: string): Promise<void> {
    const found = await this.prisma.customerAddress.findFirst({
      where: { id, customerId, deletedAt: null },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException('Address not found.');
    }
  }
}
