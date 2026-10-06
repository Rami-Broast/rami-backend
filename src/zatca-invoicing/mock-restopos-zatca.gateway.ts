import { createHash, randomUUID } from 'node:crypto';

import {
  BranchProvisionStatus,
  DocumentStatus,
  IssueDocumentInput,
  IssuedDocument,
  ProvisionBranchInput,
  ProvisionedBranch,
  RestoposZatcaGateway,
  ZatcaSubmissionStatus,
} from './restopos-zatca.interface';

interface MockChain {
  licenseKey: string;
  apiKey: string;
  vatNumber: string;
  branchName: string;
  counter: number;
  previousHash: string;
  status: BranchProvisionStatus;
  contactEmail: string;
  documents: Map<string, MockDocument>;
  /** Idempotency: orderReference -> documentId. */
  byReference: Map<string, string>;
}

interface MockDocument {
  documentId: string;
  serialNumber: string;
  submissionStatus: ZatcaSubmissionStatus;
  invoiceHash: string;
  qr: string;
  issuedAt: string;
}

/** The base64 of the hex SHA-256 of "0" — the first link in a ZATCA chain. */
const ZERO_HASH = Buffer.from(createHash('sha256').update('0').digest('hex')).toString('base64');

/** Encodes one TLV field the way a ZATCA simplified-invoice QR does. */
function tlv(tag: number, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
}

/**
 * A fully working, in-memory RestoPOS ZATCA gateway for the demo and tests.
 *
 * It invents nothing about the *real* ZATCA API: it is its own toy chain, so the
 * *platform's* flow — provision a branch, issue an invoice against that branch's
 * chain, render its QR, watch it move from PENDING to REPORTED, issue a credit
 * note — is real and demonstrable before the RestoPOS service is deployed or any
 * taxpayer is onboarded. Swapping it for the HTTP adapter changes only what
 * happens behind this port.
 *
 * The QR is a genuine TLV/base64 structure (seller, VAT number, timestamp, total,
 * VAT) so the customer app renders a real, scannable QR — its *contents* are not
 * a ZATCA-signed artefact, which is exactly what the deployed service provides.
 *
 * State lives in memory: it is a demo stand-in for Firestore, and a restart
 * resets the fake chains. Nothing here persists tax records — the real service
 * does.
 */
export class MockRestoposZatcaGateway implements RestoposZatcaGateway {
  readonly name = 'mock';

  private readonly chains = new Map<string, MockChain>();

  provisionBranch(input: ProvisionBranchInput): Promise<ProvisionedBranch> {
    const licenseKey = `EXT-MOCK-${randomUUID().slice(0, 8).toUpperCase()}`;
    const apiKey = createHash('sha256').update(`${licenseKey}:${randomUUID()}`).digest('hex');

    this.chains.set(licenseKey, {
      licenseKey,
      apiKey,
      vatNumber: input.vatNumber,
      branchName: input.branchName,
      counter: 0,
      previousHash: ZERO_HASH,
      status: 'READY',
      contactEmail: input.contactEmail,
      documents: new Map(),
      byReference: new Map(),
    });

    // The mock approves and onboards instantly — no OTP, no operator step.
    return Promise.resolve({ licenseKey, apiKey, status: 'READY' });
  }

  refreshProvisioning(licenseKey: string): Promise<ProvisionedBranch> {
    const chain = this.chains.get(licenseKey);
    if (!chain) {
      return Promise.resolve({
        licenseKey,
        apiKey: null,
        status: 'FAILED',
        detail: 'No such mock licence.',
      });
    }
    return Promise.resolve({ licenseKey, apiKey: chain.apiKey, status: chain.status });
  }

  issueDocument(input: IssueDocumentInput): Promise<IssuedDocument> {
    const chain = this.requireChain(input.licenseKey, input.apiKey);

    // Idempotency on the order reference, exactly like /external/order.
    const existingId = chain.byReference.get(input.orderReference);
    if (existingId) {
      return Promise.resolve(this.toIssued(chain.documents.get(existingId)!));
    }

    chain.counter += 1;
    const prefix = input.documentType === 'credit_note' ? 'CN' : 'INV';
    const serialNumber = `${prefix}-${chain.counter.toString().padStart(6, '0')}`;
    const documentId = `${chain.licenseKey}_${serialNumber}`;
    const issuedAt = input.issuedAt.toISOString();

    const invoiceHash = createHash('sha256')
      .update(`${chain.previousHash}|${documentId}|${input.totalInclusiveMinor}`)
      .digest('base64');
    chain.previousHash = invoiceHash;

    const totalMajor = (input.totalInclusiveMinor / 100).toFixed(2);
    const vatMajor = (input.totalVatMinor / 100).toFixed(2);
    const qr = Buffer.concat([
      tlv(1, chain.branchName),
      tlv(2, chain.vatNumber),
      tlv(3, issuedAt),
      tlv(4, totalMajor),
      tlv(5, vatMajor),
    ]).toString('base64');

    // Simplified invoices are reported to ZATCA within 24h; the demo mirrors that
    // by starting PENDING and reporting on the next status read. A credit note
    // rides the same path.
    const doc: MockDocument = {
      documentId,
      serialNumber,
      submissionStatus: 'PENDING',
      invoiceHash,
      qr,
      issuedAt,
    };
    chain.documents.set(documentId, doc);
    chain.byReference.set(input.orderReference, documentId);

    return Promise.resolve(this.toIssued(doc));
  }

  getStatus(licenseKey: string, apiKey: string, documentId: string): Promise<DocumentStatus> {
    const chain = this.requireChain(licenseKey, apiKey);
    const doc = chain.documents.get(documentId);
    if (!doc) {
      return Promise.resolve({ documentId, submissionStatus: 'FAILED' });
    }
    // Stand in for the 24h reporting window having elapsed: once someone checks,
    // the demo shows it reported. Simplified -> REPORTED.
    if (doc.submissionStatus === 'PENDING') {
      doc.submissionStatus = 'REPORTED';
    }
    return Promise.resolve({
      documentId,
      submissionStatus: doc.submissionStatus,
      qr: doc.qr,
    });
  }

  private requireChain(licenseKey: string, apiKey: string): MockChain {
    const chain = this.chains.get(licenseKey);
    if (!chain || chain.apiKey !== apiKey) {
      throw new Error('Unknown mock licence or API key.');
    }
    return chain;
  }

  private toIssued(doc: MockDocument): IssuedDocument {
    return {
      documentId: doc.documentId,
      serialNumber: doc.serialNumber,
      submissionStatus: doc.submissionStatus,
      invoiceHash: doc.invoiceHash,
      qr: doc.qr,
      issuedAt: doc.issuedAt,
    };
  }
}
