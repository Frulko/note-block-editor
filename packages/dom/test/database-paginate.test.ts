// @vitest-environment happy-dom
//
// Long views render one page at a time. The part worth pinning is the restore:
// the host replaces the whole database block on every edit, so a view scrolled
// to row 400 must come back at row 400, not row 1.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let observed: Array<() => void> = [];

beforeEach(() => {
  observed = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private cb: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe() {
        observed.push(() => this.cb([{ isIntersecting: true }]));
      }
      disconnect() {}
      unobserve() {}
    },
  );
});

type Paginate = (
  container: HTMLElement,
  items: number[],
  key: string,
  render: (n: number) => HTMLElement,
) => void;

async function importPaginate(): Promise<Paginate> {
  const mod = await import('../src/database');
  return (mod as unknown as { __paginate: Paginate }).__paginate;
}

const row = (n: number) => {
  const d = document.createElement('div');
  d.className = 'row';
  d.textContent = String(n);
  return d;
};
const rowCount = (c: HTMLElement) => c.querySelectorAll('.row').length;

describe('view pagination', () => {
  it('renders only the first page of a long list', async () => {
    const paginate = await importPaginate();
    const c = document.createElement('div');
    paginate(c, Array.from({ length: 500 }, (_, i) => i), 'k1', row);
    expect(rowCount(c)).toBe(50);
    expect(c.querySelector('.nbe-db-sentinel')).not.toBeNull();
  });

  it('renders everything and drops the sentinel when the list is short', async () => {
    const paginate = await importPaginate();
    const c = document.createElement('div');
    paginate(c, [1, 2, 3], 'k2', row);
    expect(rowCount(c)).toBe(3);
    expect(c.querySelector('.nbe-db-sentinel')).toBeNull();
  });

  it('grows a page at a time as the sentinel comes into view', async () => {
    const paginate = await importPaginate();
    const c = document.createElement('div');
    paginate(c, Array.from({ length: 130 }, (_, i) => i), 'k3', row);
    observed[0]!();
    expect(rowCount(c)).toBe(100);
    observed[0]!();
    expect(rowCount(c)).toBe(130);
    // the list is exhausted, so the sentinel is gone
    expect(c.querySelector('.nbe-db-sentinel')).toBeNull();
  });

  it('keeps new rows in order, ahead of the sentinel', async () => {
    const paginate = await importPaginate();
    const c = document.createElement('div');
    paginate(c, Array.from({ length: 200 }, (_, i) => i), 'k4', row);
    observed[0]!();
    const texts = [...c.querySelectorAll('.row')].map((e) => e.textContent);
    expect(texts[0]).toBe('0');
    expect(texts[99]).toBe('99');
    expect(c.lastElementChild?.className).toBe('nbe-db-sentinel');
  });

  it('restores the rendered depth after a re-render of the same view', async () => {
    const paginate = await importPaginate();
    const items = Array.from({ length: 500 }, (_, i) => i);
    const first = document.createElement('div');
    paginate(first, items, 'k5', row);
    observed[0]!();
    observed[0]!();
    expect(rowCount(first)).toBe(150);

    // the host replaced the block: a fresh container, same view key
    const second = document.createElement('div');
    paginate(second, items, 'k5', row);
    expect(rowCount(second)).toBe(150);
  });

  it('keys depth per view, so one long list does not inflate another', async () => {
    const paginate = await importPaginate();
    const items = Array.from({ length: 500 }, (_, i) => i);
    const a = document.createElement('div');
    paginate(a, items, 'view-a', row);
    observed[0]!();
    const b = document.createElement('div');
    paginate(b, items, 'view-b', row);
    expect(rowCount(b)).toBe(50);
  });
});
