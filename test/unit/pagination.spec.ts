import { buildPaginationMeta, PaginationQueryDto } from '../../src/common/dto/pagination.dto';

describe('PaginationQueryDto', () => {
  it('computes skip from the one-based page number', () => {
    const query = new PaginationQueryDto();
    query.page = 3;
    query.limit = 25;

    expect(query.skip).toBe(50);
  });

  it('skips nothing on the first page', () => {
    const query = new PaginationQueryDto();
    expect(query.skip).toBe(0);
  });
});

describe('buildPaginationMeta', () => {
  it('rounds partial pages up', () => {
    const meta = buildPaginationMeta(137, { page: 1, limit: 25 });

    expect(meta.totalPages).toBe(6);
    expect(meta.hasNextPage).toBe(true);
  });

  it('reports no next page on the final page', () => {
    const meta = buildPaginationMeta(50, { page: 2, limit: 25 });

    expect(meta.totalPages).toBe(2);
    expect(meta.hasNextPage).toBe(false);
  });

  it('handles an empty result set without claiming a next page', () => {
    const meta = buildPaginationMeta(0, { page: 1, limit: 25 });

    expect(meta.totalPages).toBe(0);
    expect(meta.hasNextPage).toBe(false);
  });

  it('reports no next page when the caller has paged past the end', () => {
    const meta = buildPaginationMeta(10, { page: 99, limit: 25 });

    expect(meta.hasNextPage).toBe(false);
  });

  it('divides exactly when the total is a multiple of the limit', () => {
    expect(buildPaginationMeta(50, { page: 1, limit: 25 }).totalPages).toBe(2);
  });
});
