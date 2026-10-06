import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderStatus, OrderType, PaymentMethod } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { CartItemDto } from '../../menu/dto/menu.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * A customer's request to place an order.
 *
 * Notably carries **no prices and no totals**. What to buy is a list of product
 * IDs and quantities; what it costs is decided server-side by the catalog and
 * VAT engine. A client that adds a `total` field has it stripped by the global
 * whitelist before this DTO is ever seen.
 */
export class PlaceOrderDto {
  @ApiProperty({ description: 'The branch the order is placed with.' })
  @IsUUID()
  branchId!: string;

  @ApiProperty({ enum: OrderType })
  @IsEnum(OrderType)
  type!: OrderType;

  @ApiProperty({
    enum: PaymentMethod,
    description:
      'The intended payment method. CASH_ON_DELIVERY is accepted only where the branch enables it. Online methods create the order awaiting payment; the charge itself is initiated separately (Phase 11).',
  })
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({
    description: 'Required for delivery orders. Must be one of the customer’s own addresses.',
  })
  @IsOptional()
  @IsUUID()
  customerAddressId?: string;

  @ApiProperty({ type: [CartItemDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items!: CartItemDto[];

  @ApiPropertyOptional({ description: 'A coupon code to apply. Validated and priced server-side.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MaxLength(40)
  couponCode?: string;

  @ApiPropertyOptional({ description: 'Free-text note for the kitchen or driver.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  customerNotes?: string;

  @ApiPropertyOptional({
    description: 'ISO-8601 UTC time to prepare the order for. Omit for as-soon-as-possible.',
  })
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;
}

/**
 * A customer previewing the price of a cart, optionally with a coupon.
 *
 * Same discipline as {@link PlaceOrderDto}: carries what to buy, never what it
 * costs. Unlike the public `/pricing/quote`, this runs authenticated so a coupon
 * can be evaluated for the specific customer (per-customer usage limits). It is
 * read-only — no coupon usage is recorded — so the authoritative, atomic
 * application still happens at order placement.
 */
export class QuoteOrderDto {
  @ApiProperty({ description: 'The branch the order would be placed with.' })
  @IsUUID()
  branchId!: string;

  @ApiProperty({ enum: OrderType })
  @IsEnum(OrderType)
  type!: OrderType;

  @ApiProperty({ type: [CartItemDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items!: CartItemDto[];

  @ApiPropertyOptional({
    description: 'A coupon code to preview. Validated and priced server-side.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MaxLength(40)
  couponCode?: string;

  @ApiPropertyOptional({
    description:
      'The saved address this would be delivered to. The delivery fee depends on ' +
      'its distance from the branch, so a quote without one is priced at the base ' +
      'fee rather than refused — the customer still sees totals while choosing.',
  })
  @IsOptional()
  @IsUUID()
  customerAddressId?: string;
}

/** E.164: a leading +, then 8–15 digits, first digit non-zero. Matches the auth DTO. */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Counter payment methods a staff member may record at the point of sale. */
const COUNTER_PAYMENT_METHODS = [PaymentMethod.CASH, PaymentMethod.CASH_ON_DELIVERY] as const;

/**
 * A delivery address entered at the counter for a walk-in / phone order.
 *
 * The customer placing by phone rarely has a saved address, so staff enter one
 * inline. It is persisted as one of that customer's addresses (so the normal
 * delivery leg — snapshot at READY, driver assignment — works unchanged) and
 * reused on their next order. Carries no coordinates: the counter has no map,
 * and the driver app resolves the address text.
 */
export class CounterOrderAddressDto {
  @ApiProperty({ example: 'King Fahd Rd, Building 12' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  line1!: string;

  @ApiPropertyOptional({ example: 'Flat 4, second floor' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  line2?: string;

  @ApiPropertyOptional({ example: 'Al Olaya' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  district?: string;

  @ApiProperty({ example: 'Riyadh' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  city!: string;

  @ApiPropertyOptional({ example: '12345' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @ApiPropertyOptional({ description: 'Delivery notes for the driver (gate code, landmark, …).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    description:
      'Drop-off latitude. Optional: without a pin the delivery is charged the ' +
      'base fee rather than refused, because a staff member typing an address ' +
      'over the phone often has no coordinates.',
    minimum: -90,
    maximum: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ description: 'Drop-off longitude.', minimum: -180, maximum: 180 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({ example: 'Home' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  label?: string;
}

/**
 * A branch staff member placing an order at the counter for a walk-in or phone
 * customer (§ Branch POS).
 *
 * Same money discipline as the customer path: **no prices, ever** — what to buy
 * is product IDs and quantities, and the catalog + VAT engine decide the total.
 * The differences from {@link PlaceOrderDto} are that the customer is identified
 * by phone (found or created) rather than being the caller, and payment is
 * settled at the counter (cash) rather than online. The branch is validated
 * against the caller's scope server-side — a branch user can only place orders
 * for their own branch.
 */
export class CounterOrderDto {
  @ApiProperty({ description: 'The branch taking the order. Must be one the caller can reach.' })
  @IsUUID()
  branchId!: string;

  @ApiProperty({ enum: OrderType })
  @IsEnum(OrderType)
  type!: OrderType;

  @ApiProperty({
    example: '+966500000000',
    description:
      "The customer's phone in E.164. An existing customer is reused; a new one is created.",
  })
  @Transform(trim)
  @IsString()
  @Matches(E164, { message: 'customerPhone must be a valid E.164 number, e.g. +966500000000' })
  customerPhone!: string;

  @ApiPropertyOptional({
    description: "The customer's name, saved only when creating a new customer.",
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  customerName?: string;

  @ApiProperty({
    enum: COUNTER_PAYMENT_METHODS,
    description:
      'CASH is paid at the counter; CASH_ON_DELIVERY is collected by the driver (delivery orders on branches that enable it). Online/card payment is the customer app’s flow, not the counter’s.',
  })
  @IsIn(COUNTER_PAYMENT_METHODS)
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({
    default: false,
    description:
      'For CASH only: true if the money was taken now (walk-in paying up front). Left pending for a phone order paid on collection.',
  })
  @IsOptional()
  @IsBoolean()
  cashCollected?: boolean;

  @ApiPropertyOptional({
    type: CounterOrderAddressDto,
    description: 'Required for a delivery order — where the driver takes it.',
  })
  @ValidateIf((dto: CounterOrderDto) => dto.type === OrderType.DELIVERY)
  @ValidateNested()
  @Type(() => CounterOrderAddressDto)
  deliveryAddress?: CounterOrderAddressDto;

  @ApiProperty({ type: [CartItemDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items!: CartItemDto[];

  @ApiPropertyOptional({ description: 'A coupon code to apply. Validated and priced server-side.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MaxLength(40)
  couponCode?: string;

  @ApiPropertyOptional({ description: 'Free-text note for the kitchen or driver.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  customerNotes?: string;

  @ApiPropertyOptional({
    description: 'ISO-8601 UTC time to prepare the order for. Omit for as-soon-as-possible.',
  })
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;
}

/** A reason attached to a cancellation, recorded on the status history. */
export class CancelOrderDto {
  @ApiPropertyOptional({ description: 'Why the order is being cancelled.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * A **customer** cancelling their own order. The reason is required here where
 * it is optional for staff, on the owner's instruction that a cancellation
 * comes "with proper reasoning".
 *
 * The asymmetry is deliberate rather than an oversight: staff cancelling
 * already act inside a branch that knows why, and their reason is recorded
 * against a named user. A customer's cancellation is the branch's only account
 * of why an order it was about to cook disappeared.
 */
export class CustomerCancelOrderDto {
  @ApiProperty({
    description: 'Why you are cancelling. Recorded on the order and read by the branch.',
    maxLength: 500,
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/**
 * A branch rejecting an incoming order (§7). A reason is required and recorded
 * on the status-history entry; the client is expected to present canned choices
 * (Restaurant too busy, Item unavailable, Branch closed, Delivery unavailable,
 * Other) — the server keeps them as free text so a new option needs no
 * migration.
 */
export class RejectOrderDto {
  @ApiProperty({ description: 'Why the branch is rejecting the order.' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

/** Staff order listing filters, on top of the shared pagination parameters. */
export class ListOrdersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Restrict to one branch. Validated against the caller’s scope; owners may name any branch, branch staff only their own.',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({ description: 'Restrict to one customer.' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    description:
      'Find an order by its 12-digit reference, its branch order number, or the customer’s phone. Matches from the start of the value, so a partial reference read off a docket still finds it. Always narrowed by the caller’s branch scope — a branch user searching a reference from another branch finds nothing.',
    example: '482913066571',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  search?: string;
}

/** Customer’s own-order listing filters. */
export class MyOrdersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
}
