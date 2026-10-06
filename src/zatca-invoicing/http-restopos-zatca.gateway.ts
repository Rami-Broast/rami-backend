import {
  DocumentStatus,
  IssueDocumentInput,
  IssuedDocument,
  ProvisionBranchInput,
  ProvisionedBranch,
  RestoposZatcaGateway,
  ZatcaSubmissionStatus,
} from './restopos-zatca.interface';

/**
 * Talks to a deployed RestoPOS ZATCA service over its documented external API
 * (`/external/*`). It is used only when configured with a base URL and is
 * otherwise never constructed — the demo runs entirely on the mock.
 *
 * **Nothing about the endpoint shapes is invented.** Every request body below
 * matches the RestoPOS `restopos-zatca-service` external routes as they exist:
 * `/external/register`, `/external/api-key`, `/external/onboard`,
 * `/external/invoice` and `/external/invoice/status`. When that service changes
 * its contract, this adapter changes with it — the same rule as the Tap adapter.
 *
 * The one thing this adapter cannot do on its own is the **operator approval**
 * step: after `register`, a human approves the licence in RestoPOS-Admin before
 * an API key can be minted. So `provisionBranch` returns `PENDING_APPROVAL` with
 * the licence key, and `refreshProvisioning` completes once approved.
 */
export class HttpRestoposZatcaGateway implements RestoposZatcaGateway {
  readonly name = 'restopos-http';

  constructor(
    private readonly baseUrl: string,
    /** This backend's own public URL, sent as the licence's `backendUrl`. */
    private readonly backendUrl: string,
    /** Where RestoPOS should POST status callbacks; optional. */
    private readonly webhookUrl: string | undefined,
    private readonly timeoutMs = 30_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async provisionBranch(input: ProvisionBranchInput): Promise<ProvisionedBranch> {
    const body = await this.post('/external/register', {
      businessName: input.branchName,
      businessNameAr: input.branchNameAr,
      vatNumber: input.vatNumber,
      crNumber: input.crNumber,
      branchName: input.branchName,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      backendUrl: this.backendUrl,
      webhookUrl: input.webhookUrl ?? this.webhookUrl,
      ...(input.parentAccount ? { parentAccount: input.parentAccount } : {}),
      address: {
        street: input.address.street,
        building: input.address.building,
        plot: input.address.plot,
        district: input.address.district,
        city: input.address.city,
        postalCode: input.address.postalCode,
      },
    });

    return {
      licenseKey: String(body.licenseKey),
      apiKey: null,
      status: 'PENDING_APPROVAL',
      detail:
        'Registered with RestoPOS. Approve this licence in RestoPOS-Admin, then ' +
        'call refresh to mint its API key and onboard the device.',
    };
  }

  async refreshProvisioning(licenseKey: string, contactEmail: string): Promise<ProvisionedBranch> {
    // Mint the API key (only succeeds once the licence is approved).
    let apiKey: string;
    try {
      const keyRes = await this.post('/external/api-key', { licenseKey, contactEmail });
      apiKey = String(keyRes.apiKey);
    } catch (error) {
      return {
        licenseKey,
        apiKey: null,
        status: 'PENDING_APPROVAL',
        detail: (error as Error).message,
      };
    }

    // Onboard the ZATCA device. In sandbox the OTP is fixed server-side; in
    // simulation/production a real FATOORA OTP is required and is supplied out
    // of band (this adapter does not hold taxpayer OTPs).
    try {
      await this.post('/external/onboard', { deviceName: `RamiBroast-${licenseKey}` }, apiKey);
    } catch (error) {
      return {
        licenseKey,
        apiKey,
        status: 'PENDING_APPROVAL',
        detail: `API key issued but onboarding is incomplete: ${(error as Error).message}`,
      };
    }

    return { licenseKey, apiKey, status: 'READY' };
  }

  async issueDocument(input: IssueDocumentInput): Promise<IssuedDocument> {
    const issued = input.issuedAt;
    const issueDate = issued.toISOString().slice(0, 10);
    const issueTime = issued.toISOString().slice(11, 19);
    const serialNumber =
      input.documentType === 'credit_note'
        ? `CN-${input.orderReference}`
        : `INV-${input.orderReference}`;

    const body = await this.post(
      '/external/invoice',
      {
        invoiceType: input.invoiceType,
        documentType: input.documentType,
        serialNumber,
        issueDate,
        issueTime,
        paymentMethod: input.paymentMethod,
        items: input.lines.map((line) => ({
          id: line.id,
          name: line.name,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          vatPercent: line.vatPercent,
        })),
        ...(input.originalInvoiceNumber
          ? { originalInvoiceNumber: input.originalInvoiceNumber }
          : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.buyer ? { buyer: input.buyer } : {}),
      },
      input.apiKey,
    );

    return {
      documentId: asString(body.documentId) || asString(body.id),
      serialNumber: asString(body.serialNumber) || serialNumber,
      submissionStatus: normaliseStatus(body.submissionStatus),
      invoiceHash: asString(body.invoiceHash),
      qr: asString(body.qr),
      issuedAt: asString(body.createdAt) || issued.toISOString(),
    };
  }

  async getStatus(
    _licenseKey: string,
    apiKey: string,
    documentId: string,
  ): Promise<DocumentStatus> {
    const body = await this.post('/external/invoice/status', { documentId }, apiKey);
    return {
      documentId,
      submissionStatus: normaliseStatus(body.submissionStatus),
      qr: asString(body.qr) || undefined,
    };
  }

  private async post(
    path: string,
    payload: Record<string, unknown>,
    apiKey?: string,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await res.text();
      const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (!res.ok) {
        const message = (json.error as string) || (json.message as string) || `HTTP ${res.status}`;
        throw new Error(`RestoPOS ${path} failed: ${message}`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Coerces an unknown JSON value to a string, without stringifying objects. */
function asString(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
}

function normaliseStatus(value: unknown): ZatcaSubmissionStatus {
  const s = asString(value).toUpperCase();
  if (s === 'REPORTED' || s === 'CLEARED' || s === 'FAILED' || s === 'PENDING') {
    return s;
  }
  // RestoPOS uses various in-flight labels; treat anything unrecognised as
  // pending rather than guessing it succeeded.
  return 'PENDING';
}
