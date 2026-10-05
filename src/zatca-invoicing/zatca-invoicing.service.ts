import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Order,
  PaymentMethod,
  Prisma,
  ZatcaDocumentKind,
  ZatcaProvisionStatus,
  ZatcaSubmissionState,
} from '@prisma/client';

import { assertBranchAccess, resolveRequestedBranches } from '../branches/branch-scope';
import { Actor } from '../auth/types/actor';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { BreakdownRow } from '../vat/order-breakdown';
import { buildZatcaInvoiceLines, sourceLinesFromBreakdown } from './invoice-lines';
import {
  BranchProvisionStatus,
  ProvisionBranchInput,
  RESTOPOS_ZATCA,
  RestoposZatcaGateway,
  ZatcaPaymentMethod,
  ZatcaSubmissionStatus,
} from './restopos-zatca.interface';

/**
 * Orchestrates ZATCA e-invoicing through the RestoPOS port.
 *
 * Everything here is **best-effort and post-commit**, the same rule as
 * notification dispatch: issuing an invoice must never break placing, paying for
 * or refunding an order. A failure is logged and left for a retry/status sweep —
 * the order is already valid without the invoice, and a simplified invoice is
 * reported to ZATCA asynchronously anyway.
 *
 * It never computes a payable amount. The invoice total is reconciled to the
 * order's captured `totalMinor` snapshot (see `invoice-lines.ts`); if they ever
 * disagree the issue is refused rather than a wrong tax record written.
 */
@Injectable()
export class ZatcaInvoicingService {
  private readonly logger = new Logger(ZatcaInvoicingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(RESTOPOS_ZATCA) private readonly gateway: RestoposZatcaGateway,
  ) {}

  get enabled(): boolean {
    return this.config.zatca.enabled;
  }

  /**
   * Registers a branch from its own record: loads the branch, builds the ZATCA
   * registration input from its fields plus the chain's shared VAT number, and
   * provisions it. This is what the branch-creation hook calls. Best-effort.
   */
  async provisionBranchById(branchId: string): Promise<void> {
    if (!this.enabled) return;
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) return;

    const input: ProvisionBranchInput = {
      vatNumber: this.config.zatca.sellerVatNumber ?? '',
      crNumber: branch.zatcaCrNumber ?? '',
      branchName: branch.name,
      branchNameAr: branch.nameAr ?? branch.name,
      contactEmail: `branch-${branch.code}@rami.local`,
      contactPhone: branch.phone ?? '',
      parentAccount: this.config.zatca.chainOwner ?? undefined,
      address: {
        street: branch.addressLine,
        building: branch.zatcaBuildingNumber ?? '',
        plot: branch.zatcaPlotIdentification ?? '',
        district: branch.district ?? '',
        city: branch.city,
        postalCode: branch.zatcaPostalCode ?? '',
      },
    };
    await this.provisionBranch(branchId, input);
  }

  /**
   * Registers a branch as its own ZATCA licence/device and records the result.
   * Called when a branch is created (or re-tried from the admin panel). Safe to
   * call more than once — an existing registration is returned untouched.
   */
  async provisionBranch(branchId: string, input: ProvisionBranchInput): Promise<void> {
    if (!this.enabled) return;
    const existing = await this.prisma.branchZatcaRegistration.findUnique({ where: { branchId } });
    if (existing && existing.status === ZatcaProvisionStatus.READY) return;

    try {
      const result = await this.gateway.provisionBranch(input);
      await this.prisma.branchZatcaRegistration.upsert({
        where: { branchId },
        create: {
          branchId,
          licenseKey: result.licenseKey,
          apiKey: result.apiKey,
          status: mapProvisionStatus(result.status),
          provisionNote: result.detail ?? null,
          vatNumber: input.vatNumber,
          crNumber: input.crNumber,
        },
        update: {
          licenseKey: result.licenseKey,
          apiKey: result.apiKey,
          status: mapProvisionStatus(result.status),
          provisionNote: result.detail ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(
        `ZATCA provisioning failed for branch ${branchId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Issues the tax invoice for an order once it represents a real, captured
   * sale. Idempotent: an order already invoiced returns without a second issue.
   */
  async issueInvoiceForOrder(orderId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const already = await this.prisma.restoposInvoice.findUnique({
        where: { orderId_kind: { orderId, kind: ZatcaDocumentKind.INVOICE } },
      });
      if (already) return;

      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return;

      const registration = await this.loadReadyRegistration(order.branchId);
      if (!registration) return;

      const built = this.buildLines(order);
      const issued = await this.gateway.issueDocument({
        licenseKey: registration.licenseKey,
        apiKey: registration.apiKey!,
        orderReference: order.referenceId,
        invoiceType: 'simplified',
        documentType: 'invoice',
        issuedAt: new Date(),
        paymentMethod: await this.paymentMethodFor(orderId),
        lines: built.lines,
        vatRate: Number(order.vatRate),
        totalExclusiveMinor: built.totalExclusiveMinor,
        totalVatMinor: built.totalVatMinor,
        totalInclusiveMinor: built.totalInclusiveMinor,
      });

      await this.prisma.restoposInvoice.create({
        data: {
          orderId: order.id,
          branchId: order.branchId,
          registrationId: registration.id,
          kind: ZatcaDocumentKind.INVOICE,
          documentId: issued.documentId,
          serialNumber: issued.serialNumber,
          submissionStatus: mapSubmission(issued.submissionStatus),
          invoiceHash: issued.invoiceHash || null,
          qr: issued.qr || null,
          totalExclusiveMinor: built.totalExclusiveMinor,
          totalVatMinor: built.totalVatMinor,
          totalInclusiveMinor: built.totalInclusiveMinor,
          issuedAt: new Date(issued.issuedAt),
        },
      });
    } catch (error) {
      this.logger.warn(`ZATCA invoice failed for order ${orderId}: ${(error as Error).message}`);
    }
  }

  /**
   * Issues a credit note against an order's invoice for a refunded amount.
   * Requires the original invoice to exist; idempotent per order.
   */
  async issueCreditNoteForRefund(orderId: string, reason: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const already = await this.prisma.restoposInvoice.findUnique({
        where: { orderId_kind: { orderId, kind: ZatcaDocumentKind.CREDIT_NOTE } },
      });
      if (already) return;

      const invoice = await this.prisma.restoposInvoice.findUnique({
        where: { orderId_kind: { orderId, kind: ZatcaDocumentKind.INVOICE } },
      });
      if (!invoice) {
        this.logger.warn(`No ZATCA invoice to credit for order ${orderId}; skipping credit note.`);
        return;
      }

      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return;
      const registration = await this.loadReadyRegistration(order.branchId);
      if (!registration) return;

      const built = this.buildLines(order);
      const issued = await this.gateway.issueDocument({
        licenseKey: registration.licenseKey,
        apiKey: registration.apiKey!,
        orderReference: `${order.referenceId}-CN`,
        invoiceType: 'simplified',
        documentType: 'credit_note',
        issuedAt: new Date(),
        paymentMethod: await this.paymentMethodFor(orderId),
        lines: built.lines,
        vatRate: Number(order.vatRate),
        totalExclusiveMinor: built.totalExclusiveMinor,
        totalVatMinor: built.totalVatMinor,
        totalInclusiveMinor: built.totalInclusiveMinor,
        originalInvoiceNumber: invoice.serialNumber,
        reason,
      });

      await this.prisma.restoposInvoice.create({
        data: {
          orderId: order.id,
          branchId: order.branchId,
          registrationId: registration.id,
          kind: ZatcaDocumentKind.CREDIT_NOTE,
          documentId: issued.documentId,
          serialNumber: issued.serialNumber,
          submissionStatus: mapSubmission(issued.submissionStatus),
          invoiceHash: issued.invoiceHash || null,
          qr: issued.qr || null,
          totalExclusiveMinor: built.totalExclusiveMinor,
          totalVatMinor: built.totalVatMinor,
          totalInclusiveMinor: built.totalInclusiveMinor,
          originalInvoiceId: invoice.documentId,
          issuedAt: new Date(issued.issuedAt),
        },
      });
    } catch (error) {
      this.logger.warn(
        `ZATCA credit note failed for order ${orderId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Refreshes the submission status of a document from RestoPOS (the fallback
   * to the webhook). Used by the admin invoice view and a background sweep.
   */
  async refreshStatus(documentId: string): Promise<ZatcaSubmissionState | null> {
    if (!this.enabled) return null;
    const record = await this.prisma.restoposInvoice.findUnique({
      where: { documentId },
      include: { registration: true },
    });
    if (!record || !record.registration.apiKey) return null;

    try {
      const status = await this.gateway.getStatus(
        record.registration.licenseKey,
        record.registration.apiKey,
        documentId,
      );
      const mapped = mapSubmission(status.submissionStatus);
      await this.prisma.restoposInvoice.update({
        where: { documentId },
        data: {
          submissionStatus: mapped,
          ...(status.qr ? { qr: status.qr } : {}),
          ...(mapped === ZatcaSubmissionState.REPORTED || mapped === ZatcaSubmissionState.CLEARED
            ? { reportedAt: new Date() }
            : {}),
        },
      });
      return mapped;
    } catch (error) {
      this.logger.warn(
        `ZATCA status refresh failed for ${documentId}: ${(error as Error).message}`,
      );
      return record.submissionStatus;
    }
  }

  /**
   * Handles an inbound RestoPOS status webhook. RestoPOS signs the raw JSON body
   * with HMAC-SHA256 (hex) in `x-restopos-signature`. The signature is verified
   * against the configured secret; then — rather than *trusting* the payload's
   * status — the document's status is re-fetched authoritatively from RestoPOS.
   * So even a forged nudge cannot set a false status; it only prompts a pull.
   */
  async handleStatusWebhook(
    rawBody: Buffer | string,
    signature: string | undefined,
  ): Promise<void> {
    if (!this.enabled) return;

    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = createHmac('sha256', this.config.zatca.webhookSecret)
      .update(body)
      .digest('hex');
    const provided = signature ?? '';
    const ok =
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!ok) {
      throw new UnauthorizedException('Invalid RestoPOS webhook signature.');
    }

    let documentId: string | undefined;
    try {
      const parsed = JSON.parse(body) as { documentId?: unknown };
      documentId = typeof parsed.documentId === 'string' ? parsed.documentId : undefined;
    } catch {
      documentId = undefined;
    }
    if (documentId) {
      await this.refreshStatus(documentId);
    }
  }

  /**
   * Lists the ZATCA documents a staff actor may see, branch-isolated exactly
   * like reports (an owner spans every branch; branch staff see their own).
   * Powers the admin Invoices view and the per-branch reported/pending counts.
   */
  async listInvoices(
    actor: Actor,
    query: {
      branchId?: string;
      status?: ZatcaSubmissionState;
      from?: string;
      to?: string;
      limit?: number;
    },
  ) {
    const scope = resolveRequestedBranches(actor, query.branchId);
    const where: Prisma.RestoposInvoiceWhereInput = {
      ...scope,
      ...(query.status ? { submissionStatus: query.status } : {}),
      ...(query.from || query.to
        ? {
            issuedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.restoposInvoice.findMany({
      where,
      orderBy: { issuedAt: 'desc' },
      take: Math.min(Math.max(query.limit ?? 100, 1), 500),
      select: {
        id: true,
        kind: true,
        documentId: true,
        serialNumber: true,
        submissionStatus: true,
        qr: true,
        invoiceHash: true,
        totalInclusiveMinor: true,
        totalVatMinor: true,
        issuedAt: true,
        reportedAt: true,
        branchId: true,
        branch: { select: { name: true, code: true } },
        order: { select: { referenceId: true, orderNumber: true } },
      },
    });
    return rows;
  }

  /** Per-branch reported/pending/failed counts for the branch-details view. */
  async statusSummary(actor: Actor, branchId?: string) {
    const scope = resolveRequestedBranches(actor, branchId);
    const grouped = await this.prisma.restoposInvoice.groupBy({
      by: ['submissionStatus'],
      where: scope,
      _count: { _all: true },
    });
    const summary: Record<string, number> = { PENDING: 0, REPORTED: 0, CLEARED: 0, FAILED: 0 };
    for (const row of grouped) summary[row.submissionStatus] = row._count._all;
    return summary;
  }

  /**
   * The customer's own tax invoice for one of their orders — the data the
   * customer app renders as a digital tax invoice with its QR. Ownership is by
   * customer id (same discipline as the rest of the customer order surface): a
   * missing or someone-else's order returns null, never another customer's.
   */
  async getInvoiceForCustomer(customerId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
      select: { id: true, orderNumber: true, referenceId: true },
    });
    if (!order) return null;

    const invoice = await this.prisma.restoposInvoice.findUnique({
      where: { orderId_kind: { orderId, kind: ZatcaDocumentKind.INVOICE } },
      select: {
        serialNumber: true,
        submissionStatus: true,
        qr: true,
        invoiceHash: true,
        totalExclusiveMinor: true,
        totalVatMinor: true,
        totalInclusiveMinor: true,
        issuedAt: true,
      },
    });
    if (!invoice) return null;

    return {
      orderNumber: order.orderNumber,
      referenceId: order.referenceId,
      isTaxInvoice: true,
      ...invoice,
    };
  }

  /** Refreshes one document's status, after checking the actor may see it. */
  async refreshInvoiceStatus(actor: Actor, documentId: string) {
    const record = await this.prisma.restoposInvoice.findUnique({
      where: { documentId },
      select: { branchId: true },
    });
    if (!record) throw new NotFoundException('No such invoice.');
    assertBranchAccess(actor, record.branchId);
    const status = await this.refreshStatus(documentId);
    return { documentId, submissionStatus: status };
  }

  private buildLines(order: Order) {
    const rows = (order.priceBreakdown as unknown as BreakdownRow[] | null) ?? [];
    if (rows.length === 0) {
      throw new Error(`Order ${order.id} has no price breakdown to invoice from.`);
    }
    const sourceLines = sourceLinesFromBreakdown(rows);
    return buildZatcaInvoiceLines(sourceLines, Number(order.vatRate), order.totalMinor);
  }

  private async loadReadyRegistration(branchId: string) {
    const registration = await this.prisma.branchZatcaRegistration.findUnique({
      where: { branchId },
    });
    if (
      !registration ||
      registration.status !== ZatcaProvisionStatus.READY ||
      !registration.apiKey
    ) {
      this.logger.warn(`Branch ${branchId} has no READY ZATCA registration; not invoicing.`);
      return null;
    }
    return registration;
  }

  private async paymentMethodFor(orderId: string): Promise<ZatcaPaymentMethod> {
    const payment = await this.prisma.payment.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
    return mapPaymentMethod(payment?.method ?? null);
  }
}

function mapProvisionStatus(status: BranchProvisionStatus): ZatcaProvisionStatus {
  switch (status) {
    case 'READY':
      return ZatcaProvisionStatus.READY;
    case 'FAILED':
      return ZatcaProvisionStatus.FAILED;
    default:
      return ZatcaProvisionStatus.PENDING_APPROVAL;
  }
}

function mapSubmission(status: ZatcaSubmissionStatus): ZatcaSubmissionState {
  switch (status) {
    case 'REPORTED':
      return ZatcaSubmissionState.REPORTED;
    case 'CLEARED':
      return ZatcaSubmissionState.CLEARED;
    case 'FAILED':
      return ZatcaSubmissionState.FAILED;
    default:
      return ZatcaSubmissionState.PENDING;
  }
}

/** Maps our payment method onto the RestoPOS/ZATCA payment vocabulary. */
function mapPaymentMethod(method: PaymentMethod | null): ZatcaPaymentMethod {
  switch (method) {
    case PaymentMethod.CASH:
    case PaymentMethod.CASH_ON_DELIVERY:
      return 'cash';
    default:
      // CARD / MADA / APPLE_PAY / GOOGLE_PAY and the unknown case all settle as
      // a card payment for ZATCA payment-means purposes.
      return 'card';
  }
}
