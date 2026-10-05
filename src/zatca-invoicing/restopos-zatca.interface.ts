import { ZatcaInvoiceLine } from './invoice-lines';

/**
 * The RestoPOS ZATCA port.
 *
 * ZATCA e-invoicing is **not** implemented in this backend — it is delegated to
 * the RestoPOS ZATCA service, which owns the certificates, the per-device
 * invoice chain and the FATOORA submission. Everything this platform does with
 * that service goes through this one interface, so RestoPOS is *one adapter
 * behind a port* rather than an assumption baked into the order and refund code.
 *
 * The types here are deliberately **RestoPOS-neutral in spirit** but shaped to
 * its documented external API (`/external/*`). The mock adapter implements the
 * whole flow for the demo and tests; the HTTP adapter talks to a deployed
 * RestoPOS ZATCA service. Which one is used is chosen once, at boot, from
 * configuration — exactly like the payment gateway.
 *
 * ## The multi-branch rule this encodes
 *
 * ZATCA requires a separate, unbroken invoice chain **per branch** (each invoice
 * embeds the previous one's hash and a counter that increments by one). RestoPOS
 * models that as one licence + one device per chain, so **one Rami Broast
 * branch = one RestoPOS licence + API key**, all grouped under one chain-owner
 * account for a single login and bill. Every call here is therefore scoped to a
 * branch's `licenseKey` + `apiKey`; nothing is chain-wide.
 */

/** Where a submitted document has got to in ZATCA's eyes. */
export type ZatcaSubmissionStatus = 'PENDING' | 'REPORTED' | 'CLEARED' | 'FAILED';

/** Whether the branch's provisioning is usable yet. */
export type BranchProvisionStatus = 'READY' | 'PENDING_APPROVAL' | 'FAILED';

/** Consumer food orders are simplified (B2C); a business buyer makes it standard. */
export type ZatcaInvoiceType = 'simplified' | 'standard';

export type ZatcaDocumentType = 'invoice' | 'credit_note';

export type ZatcaPaymentMethod = 'cash' | 'card' | 'bank_transfer';

/** What a branch registers with, from the restaurant's own records. */
export interface ProvisionBranchInput {
  /** The chain's shared VAT number (same on every branch). */
  vatNumber: string;
  /** This branch's own commercial-registration / licence number. */
  crNumber: string;
  branchName: string;
  branchNameAr: string;
  contactEmail: string;
  contactPhone: string;
  address: {
    street: string;
    building: string;
    plot: string;
    district: string;
    city: string;
    postalCode: string;
  };
  /** Where RestoPOS should call back with status updates. */
  webhookUrl?: string;
  /** Chain-owner account this branch's licence groups under (one login/bill). */
  parentAccount?: string;
}

export interface ProvisionedBranch {
  licenseKey: string;
  /** Present once approved and onboarded; null while `PENDING_APPROVAL`. */
  apiKey: string | null;
  status: BranchProvisionStatus;
  /** Human-readable next step when not yet READY (e.g. "awaiting admin approval"). */
  detail?: string;
}

export interface IssueDocumentInput {
  licenseKey: string;
  apiKey: string;
  /** Idempotency key — the order's `referenceId`. A replay returns the first result. */
  orderReference: string;
  invoiceType: ZatcaInvoiceType;
  documentType: ZatcaDocumentType;
  issuedAt: Date;
  paymentMethod: ZatcaPaymentMethod;
  lines: ZatcaInvoiceLine[];
  /** VAT rate as a ratio, e.g. 0.15. */
  vatRate: number;
  /** Reconciled document totals in halalas, for the adapter to cross-check. */
  totalExclusiveMinor: number;
  totalVatMinor: number;
  totalInclusiveMinor: number;
  /** Required on a credit note: the invoice it amends and why (BR-KSA-56/17). */
  originalInvoiceNumber?: string;
  reason?: string;
  /** Only for a standard (B2B) invoice. */
  buyer?: {
    name: string;
    vatNumber: string;
    address?: {
      street?: string;
      building?: string;
      plot?: string;
      district?: string;
      city?: string;
      postalCode?: string;
    };
  };
}

/** A document the ZATCA service accepted. For a simplified invoice this is valid
 * to hand the customer immediately; reporting to ZATCA completes within 24h. */
export interface IssuedDocument {
  /** RestoPOS document id, scoped to the branch's licence. */
  documentId: string;
  /** The ZATCA serial number RestoPOS allocated. */
  serialNumber: string;
  submissionStatus: ZatcaSubmissionStatus;
  /** SHA-256 invoice hash (chain link). */
  invoiceHash: string;
  /** TLV-encoded, base64 QR payload — what the customer app renders as a QR. */
  qr: string;
  issuedAt: string;
}

export interface DocumentStatus {
  documentId: string;
  submissionStatus: ZatcaSubmissionStatus;
  qr?: string;
}

export interface RestoposZatcaGateway {
  /** Stable adapter name, persisted on every ZATCA-facing record. */
  readonly name: string;

  /**
   * Registers a branch as its own ZATCA device/licence under the chain owner.
   * On the HTTP adapter the result may be `PENDING_APPROVAL` until an operator
   * approves the licence in RestoPOS-Admin; the mock returns `READY` at once.
   */
  provisionBranch(input: ProvisionBranchInput): Promise<ProvisionedBranch>;

  /**
   * Fetches the API key + finishes onboarding for a branch registered earlier,
   * once it has been approved. Idempotent. Returns the branch's current state.
   */
  refreshProvisioning(licenseKey: string, contactEmail: string): Promise<ProvisionedBranch>;

  /** Issues a tax invoice or a credit note on the branch's chain. */
  issueDocument(input: IssueDocumentInput): Promise<IssuedDocument>;

  /** Reads a document's current ZATCA submission status. */
  getStatus(licenseKey: string, apiKey: string, documentId: string): Promise<DocumentStatus>;
}

/** DI token for the configured RestoPOS ZATCA adapter. */
export const RESTOPOS_ZATCA = Symbol('RESTOPOS_ZATCA');
