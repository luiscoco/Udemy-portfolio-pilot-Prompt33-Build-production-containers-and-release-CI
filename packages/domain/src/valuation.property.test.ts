import { describe, expect, it } from 'vitest';
import { validateLongOnlyLedger } from './ledger.js';
import { calculatePortfolioSummary, type ValuationQuote, type ValuationTrade } from './valuation.js';

// Seeded randomized ledgers checked against an independent exact-rational reference model
// (milestone 31). The model below shares no code with the implementation: it is a direct reading
// of the weighted-average-cost rules (buys add quantity and cost including fees; a sale removes
// basis in proportion to quantity; realized = proceeds - sale fees - removed basis; output is
// rounded half away from zero only at the end). Fixed seeds keep every run identical.

type Fraction = { n: bigint; d: bigint };
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a || 1n; };
const frac = (n: bigint, d = 1n): Fraction => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; };
const add = (a: Fraction, b: Fraction) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Fraction, b: Fraction) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Fraction, b: Fraction) => frac(a.n * b.n, a.d * b.d);
const div = (a: Fraction, b: Fraction) => frac(a.n * b.d, a.d * b.n);
const ZERO = frac(0n);
function parse(text: string): Fraction {
  const [whole, part = ''] = text.split('.');
  return frac(BigInt(whole! + part), 10n ** BigInt(part.length));
}
function round(value: Fraction, places: number): string {
  const scale = 10n ** BigInt(places);
  const magnitude = value.n < 0n ? -value.n : value.n;
  let units = (magnitude * scale) / value.d;
  if (((magnitude * scale) % value.d) * 2n >= value.d) units++;
  const text = units.toString().padStart(places + 1, '0');
  return `${value.n < 0n && units ? '-' : ''}${text.slice(0, -places)}.${text.slice(-places)}`;
}

function rng(seed: number) {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const NOW = '2026-10-02T12:00:00.000Z';
const SECURITIES = ['sec-a', 'sec-b', 'sec-c'];

/** A chronological ledger (some deliberately oversold), then shuffled as the database could return it. */
function generate(random: () => number) {
  const decimal = (max: number, places: number) => {
    const units = 1 + Math.floor(random() * max * 10 ** places);
    const text = String(units).padStart(places + 1, '0');
    return places ? `${text.slice(0, -places)}.${text.slice(-places)}`.replace(/\.?0+$/, '') : text;
  };
  const held = new Map<string, Fraction>();
  const oversell = random() < 0.15;
  const rows: ValuationTrade[] = [];
  let day = 0;
  const count = 1 + Math.floor(random() * 24);
  for (let order = 1; order <= count; order++) {
    if (random() < 0.7) day += 1 + Math.floor(random() * 5); // otherwise an equal timestamp
    const securityId = SECURITIES[Math.floor(random() * SECURITIES.length)]!;
    const position = held.get(securityId) ?? ZERO;
    const price = decimal(999, Math.floor(random() * 5));
    let side: 'BUY' | 'SELL' = position.n > 0n && random() < 0.4 ? 'SELL' : 'BUY';
    let quantity = decimal(50, Math.floor(random() * 5));
    if (side === 'SELL') {
      const all = random() < 0.25;
      // Sell all, or a fraction of the holding (0.0001 resolution), within inventory.
      const fraction = frac(BigInt(1 + Math.floor(random() * 9999)), 10000n);
      const amount = all ? position : mul(position, fraction);
      const text = round(amount, 10).replace(/\.?0+$/, '');
      if (text === '0' || text === '') side = 'BUY'; else quantity = text;
      if (side === 'SELL' && sub(position, parse(quantity)).n < 0n) quantity = round(position, 10).replace(/\.?0+$/, '');
    }
    if (oversell && side === 'SELL' && random() < 0.5) quantity = round(add(position, parse('0.0000000001')), 10).replace(/\.?0+$/, '');
    const gross = mul(parse(quantity), parse(price));
    let fees = (Math.floor(random() * 1000) / 100).toFixed(2).replace(/\.?0+$/, '') || '0';
    if (side === 'SELL' && sub(gross, parse(fees)).n < 0n) fees = '0';
    held.set(securityId, side === 'BUY' ? add(position, parse(quantity)) : sub(position, parse(quantity)));
    rows.push({ securityId, side, quantity, price, fees, ledgerOrder: BigInt(order), occurredAt: new Date(Date.UTC(2025, 0, 1 + day)).toISOString() });
  }
  const shuffled = [...rows];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
  const quotes: ValuationQuote[] = SECURITIES.filter(() => random() < 0.85).map(securityId => ({ securityId, price: decimal(500, 2), currency: 'USD', asOf: NOW, provider: 'property', isSynthetic: true }));
  return { chronological: rows, shuffled, quotes };
}

/** Reference result, or null when the chronological ledger is ever short. */
function reference(chronological: readonly ValuationTrade[], quotes: readonly ValuationQuote[]) {
  const positions = new Map<string, { quantity: Fraction; basis: Fraction; sold: Fraction; realized: Fraction }>();
  for (const t of chronological) {
    const p = positions.get(t.securityId) ?? { quantity: ZERO, basis: ZERO, sold: ZERO, realized: ZERO };
    const quantity = parse(t.quantity), gross = mul(quantity, parse(t.price)), fees = parse(t.fees);
    if (t.side === 'BUY') { p.quantity = add(p.quantity, quantity); p.basis = add(add(p.basis, gross), fees); }
    else {
      if (sub(p.quantity, quantity).n < 0n) return null;
      const removed = div(mul(p.basis, quantity), p.quantity);
      p.sold = add(p.sold, removed); p.realized = add(p.realized, sub(sub(gross, fees), removed));
      p.basis = sub(p.basis, removed); p.quantity = sub(p.quantity, quantity);
    }
    positions.set(t.securityId, p);
  }
  const price = new Map(quotes.map(q => [q.securityId, parse(q.price)]));
  const rows = [...positions].sort(([a], [b]) => a.localeCompare(b)).map(([securityId, p]) => {
    const open = p.quantity.n !== 0n;
    const market = !open ? ZERO : price.has(securityId) ? mul(p.quantity, price.get(securityId)!) : null;
    return { securityId, p, open, market };
  });
  const complete = rows.every(r => r.market !== null);
  const sum = (pick: (r: typeof rows[number]) => Fraction) => rows.reduce((total, r) => add(total, pick(r)), ZERO);
  const totalMarket = complete ? sum(r => r.market!) : null;
  return {
    valuationComplete: complete,
    remainingCostBasis: round(sum(r => r.p.basis), 2), soldCostBasis: round(sum(r => r.p.sold), 2), realizedGainLoss: round(sum(r => r.p.realized), 2),
    marketValue: totalMarket && round(totalMarket, 2), unrealizedGainLoss: totalMarket && round(sub(totalMarket, sum(r => r.p.basis)), 2),
    positions: rows.map(({ securityId, p, open, market }) => ({
      securityId, remainingQuantity: round(p.quantity, 10), weightedAverageAcquisitionCost: open ? round(div(p.basis, p.quantity), 10) : null,
      remainingCostBasis: round(p.basis, 2), soldCostBasis: round(p.sold, 2), realizedGainLoss: round(p.realized, 2),
      marketValue: market && round(market, 2), unrealizedGainLoss: market && round(sub(market, p.basis), 2),
      allocationWeight: totalMarket && totalMarket.n > 0n ? round(div(market!, totalMarket), 10) : null,
      quoteStatus: open ? (price.has(securityId) ? 'fresh' : 'missing') : 'not_required'
    }))
  };
}

describe('weighted average cost against an independent reference model (seeded random ledgers)', () => {
  const CASES = 400;
  it(`matches every position and total exactly, regardless of input order (${CASES} ledgers)`, () => {
    let valid = 0, rejected = 0;
    for (let seed = 1; seed <= CASES; seed++) {
      const { chronological, shuffled, quotes } = generate(rng(seed));
      const expected = reference(chronological, quotes);
      const context = `seed ${seed}: ${JSON.stringify(chronological, (_, v) => typeof v === 'bigint' ? String(v) : v)}`;
      if (!expected) {
        rejected++;
        expect(() => calculatePortfolioSummary(shuffled, quotes, NOW), context).toThrow();
        expect(validateLongOnlyLedger(chronological), context).toBe(false);
        continue;
      }
      valid++;
      const actual = calculatePortfolioSummary(shuffled, quotes, NOW);
      expect(actual, context).toMatchObject(expected);
      expect(validateLongOnlyLedger(chronological), context).toBe(true);
    }
    // The generator must exercise both outcomes, or the property says little.
    expect(valid).toBeGreaterThan(CASES / 2);
    expect(rejected).toBeGreaterThan(10);
  });

  it('never loses or creates cost: remaining + sold basis equals everything paid, per security', () => {
    for (let seed = 1001; seed <= 1200; seed++) {
      const { chronological, shuffled, quotes } = generate(rng(seed));
      if (!reference(chronological, quotes)) continue;
      const actual = calculatePortfolioSummary(shuffled, quotes, NOW);
      for (const position of actual.positions) {
        const paid = chronological.filter(t => t.securityId === position.securityId && t.side === 'BUY')
          .reduce((total, t) => add(total, add(mul(parse(t.quantity), parse(t.price)), parse(t.fees))), ZERO);
        // Each rounded component is within half a cent of its exact value.
        const difference = sub(paid, add(parse(position.remainingCostBasis.replace('-', '')), parse(position.soldCostBasis)));
        const magnitude = difference.n < 0n ? -difference.n : difference.n;
        expect(magnitude * 100n <= difference.d, `seed ${seed} ${position.securityId}: off by ${round(difference, 4)}`).toBe(true);
      }
    }
  });
});
