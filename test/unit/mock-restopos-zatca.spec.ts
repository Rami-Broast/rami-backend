import { MockRestoposZatcaGateway } from '../../src/zatca-invoicing/mock-restopos-zatca.gateway';
import { IssueDocumentInput } from '../../src/zatca-invoicing/restopos-zatca.interface';

/**
 * The mock adapter is the demo's whole ZATCA backend. These tests pin the
 * behaviour the demo and the service rely on: a branch provisions to READY, an
 * invoice issues with a QR and a hash, the same order reference is idempotent,
 * and a document moves PENDING -> REPORTED when its status is read.
 */
describe('MockRestoposZatcaGateway', () => {
  const issueInput = (over: Partial<IssueDocumentInput>): IssueDocumentInput => ({
    licenseKey: '',
    apiKey: '',
    orderReference: '000000001234',
    invoiceType: 'simplified',
    documentType: 'invoice',
    issuedAt: new Date('2026-09-27T10:00:00.000Z'),
    paymentMethod: 'card',
    lines: [{ id: '1', name: 'Item total', quantity: 1, unitPrice: 70.0, vatPercent: 15 }],
    vatRate: 0.15,
    totalExclusiveMinor: 7000,
    totalVatMinor: 1050,
    totalInclusiveMinor: 8050,
    ...over,
  });

  it('provisions a branch to READY with a licence and API key', async () => {
    const gw = new MockRestoposZatcaGateway();
    const result = await gw.provisionBranch(provisionArgs());
    expect(result.status).toBe('READY');
    expect(result.licenseKey).toMatch(/^EXT-MOCK-/);
    expect(result.apiKey).toBeTruthy();
  });

  it('issues an invoice with a QR and a chained hash, then reports it on status read', async () => {
    const gw = new MockRestoposZatcaGateway();
    const branch = await gw.provisionBranch(provisionArgs());

    const issued = await gw.issueDocument(
      issueInput({ licenseKey: branch.licenseKey, apiKey: branch.apiKey! }),
    );
    expect(issued.submissionStatus).toBe('PENDING');
    expect(issued.serialNumber).toBe('INV-000001');
    expect(issued.qr.length).toBeGreaterThan(0);
    expect(Buffer.from(issued.qr, 'base64').length).toBeGreaterThan(0);
    expect(issued.invoiceHash).toBeTruthy();

    const status = await gw.getStatus(branch.licenseKey, branch.apiKey!, issued.documentId);
    expect(status.submissionStatus).toBe('REPORTED');
  });

  it('is idempotent on the order reference', async () => {
    const gw = new MockRestoposZatcaGateway();
    const branch = await gw.provisionBranch(provisionArgs());
    const input = issueInput({ licenseKey: branch.licenseKey, apiKey: branch.apiKey! });

    const first = await gw.issueDocument(input);
    const second = await gw.issueDocument(input);
    expect(second.documentId).toBe(first.documentId);
    expect(second.serialNumber).toBe(first.serialNumber);
  });

  it('advances the serial number and chains the hash across two invoices', async () => {
    const gw = new MockRestoposZatcaGateway();
    const branch = await gw.provisionBranch(provisionArgs());

    const a = await gw.issueDocument(
      issueInput({ licenseKey: branch.licenseKey, apiKey: branch.apiKey!, orderReference: 'A' }),
    );
    const b = await gw.issueDocument(
      issueInput({ licenseKey: branch.licenseKey, apiKey: branch.apiKey!, orderReference: 'B' }),
    );
    expect(a.serialNumber).toBe('INV-000001');
    expect(b.serialNumber).toBe('INV-000002');
    expect(b.invoiceHash).not.toBe(a.invoiceHash);
  });

  it('rejects an unknown licence/API key', () => {
    const gw = new MockRestoposZatcaGateway();
    expect(() =>
      gw.issueDocument(issueInput({ licenseKey: 'EXT-MOCK-NOPE', apiKey: 'nope' })),
    ).toThrow(/Unknown mock licence/);
  });
});

function provisionArgs() {
  return {
    vatNumber: '311111111100003',
    crNumber: '1010101010',
    branchName: 'Olaya',
    branchNameAr: 'العليا',
    contactEmail: 'olaya@example.com',
    contactPhone: '+966500000000',
    address: {
      street: 'Prince Sultan Rd',
      building: '4321',
      plot: '0001',
      district: 'Al Olaya',
      city: 'Riyadh',
      postalCode: '12211',
    },
  };
}
