-- Owner-uploaded artwork, stored as bytes.
--
-- No object storage is provisioned; the alternative was asking the owner to
-- paste a URL to somewhere nobody controls. Bounded to owner artwork by the
-- `assets:write` permission — this is not where bulk images belong.
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "filename" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Asset_createdAt_idx" ON "Asset"("createdAt");
CREATE INDEX "Asset_uploadedById_idx" ON "Asset"("uploadedById");

ALTER TABLE "Asset" ADD CONSTRAINT "Asset_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
