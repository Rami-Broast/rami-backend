-- CreateEnum
CREATE TYPE "ZatcaProvisionStatus" AS ENUM ('PENDING_APPROVAL', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "ZatcaDocumentKind" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "ZatcaSubmissionState" AS ENUM ('PENDING', 'REPORTED', 'CLEARED', 'FAILED');

-- CreateTable
CREATE TABLE "BranchZatcaRegistration" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "licenseKey" TEXT NOT NULL,
    "apiKey" TEXT,
    "status" "ZatcaProvisionStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "provisionNote" TEXT,
    "vatNumber" TEXT,
    "crNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BranchZatcaRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestoposInvoice" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "kind" "ZatcaDocumentKind" NOT NULL DEFAULT 'INVOICE',
    "documentId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "submissionStatus" "ZatcaSubmissionState" NOT NULL DEFAULT 'PENDING',
    "invoiceHash" TEXT,
    "qr" TEXT,
    "totalExclusiveMinor" INTEGER NOT NULL,
    "totalVatMinor" INTEGER NOT NULL,
    "totalInclusiveMinor" INTEGER NOT NULL,
    "originalInvoiceId" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "reportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestoposInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BranchZatcaRegistration_branchId_key" ON "BranchZatcaRegistration"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchZatcaRegistration_licenseKey_key" ON "BranchZatcaRegistration"("licenseKey");

-- CreateIndex
CREATE INDEX "BranchZatcaRegistration_status_idx" ON "BranchZatcaRegistration"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RestoposInvoice_documentId_key" ON "RestoposInvoice"("documentId");

-- CreateIndex
CREATE INDEX "RestoposInvoice_branchId_submissionStatus_idx" ON "RestoposInvoice"("branchId", "submissionStatus");

-- CreateIndex
CREATE INDEX "RestoposInvoice_submissionStatus_idx" ON "RestoposInvoice"("submissionStatus");

-- CreateIndex
CREATE UNIQUE INDEX "RestoposInvoice_orderId_kind_key" ON "RestoposInvoice"("orderId", "kind");

-- AddForeignKey
ALTER TABLE "BranchZatcaRegistration" ADD CONSTRAINT "BranchZatcaRegistration_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestoposInvoice" ADD CONSTRAINT "RestoposInvoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestoposInvoice" ADD CONSTRAINT "RestoposInvoice_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestoposInvoice" ADD CONSTRAINT "RestoposInvoice_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "BranchZatcaRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
