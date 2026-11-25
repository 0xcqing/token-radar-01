// The token radar's valuation model: one snapshot of the protocol universe in, one ranked board out.
//
// A protocol is a launch candidate only when its record carries no token at all: no market cap, no
// CoinGecko id and no symbol. Records that carry any of those three already name a tradable asset and
// are kept out of the ranking, as the comparables that set the model's multiples and as the live view.
//
// The implied value is a comparables model, not a hardcoded list:
//
//   raw = tvl_usd
//       x category_multiple            median mcap/TVL of token records in the same category
//       x chain_quality                chain median relative to the whole set x depth/breadth quality
//       x structure_factor             1 for an independent record, a deep discount for a product
//       x growth_multiplier            1 + clamp(change_7d, -50, +100) / 100 x 0.35
//       x maturity_multiplier          0.6 + 0.4 x min(age_days, 1460) / 1460
//
// Category and chain multiples are robust medians of the snapshot's own mcap/TVL ratios, with ratios
// outside [0.005, 25] dropped as outliers and small samples shrunk toward the whole-set median. The
// category multiple is then clamped to 0.3x..2.5x the whole-set median so one rich comparable cannot
// set a category's price on its own. Ties are broken deterministically on raw value, TVL and slug, and
// the sorted values are forced strictly descending inside [1000, 1e14].

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelConstants {
  ratio_floor: number;
  ratio_cap: number;
  shrink_k: number;
  cat_low_ratio: number;
  cat_high_ratio: number;
  cat_abs_low: number;
  cat_abs_high: number;
  chain_low: number;
  chain_high: number;
  structure_wrapped: number;
  structure_derivative: number;
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  quality_base: number;
  quality_depth: number;
  quality_breadth: number;
  value_floor: number;
  value_ceiling: number;
}

export const MODEL: ModelConstants = {
  ratio_floor: 0.005,
  ratio_cap: 25,
  shrink_k: 4,
  cat_low_ratio: 0.3,
  cat_high_ratio: 2.5,
  cat_abs_low: 0.05,
  cat_abs_high: 3,
  chain_low: 0.6,
  chain_high: 1.6,
  structure_wrapped: 0.02,
  structure_derivative: 0.02,
  growth_floor: -50,
  growth_cap: 100,
  growth_weight: 0.35,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1460,
  unknown_age_days: 540,
  quality_base: 0.9,
  quality_depth: 0.08,
  quality_breadth: 0.04,
  value_floor: 1000,
  value_ceiling: 1e14,
};

export const MODEL_VERSION = 'comparables-2';

export interface MultipleStat {
  count: number;
  median: number | null;
  multiple: number;
}

export interface Comparables {
  overall: number;
  sample: number;
  categories: Map<string, MultipleStat>;
  chains: Map<string, MultipleStat>;
}

export interface ConfidenceParts {
  base: number;
  category: number;
  chain: number;
  age: number;
  growth: number;
  independence: number;
  chain_comparables: number;
}

export interface StructureInfo {
  kind: string;
  factor: number;
  derivative: boolean;
  note: string;
}

export interface ValueModel {
  category_multiple: number;
  category_comparables: number;
  category_median: number | null;
  chain_factor: number;
  chain_comparables: number;
  quality_factor: number;
  chain_quality: number;
  structure_factor: number;
  structure_kind: string;
  structure_derivative: boolean;
  structure_note: string;
  quality_adjustment: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  age_days: number | null;
  raw_value: number;
  tie_adjustment: number;
  implied_value_usd: number;
  confidence: number;
  confidence_label: string;
  confidence_parts: ConfidenceParts;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  confidence: number;
  confidence_label: string;
  structure: StructureInfo;
  model: ValueModel;
  farm_steps: string[];
  what_would_change: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  ratio: number;
}

export interface MultipleRow {
  key: string;
  count: number;
  median: number | null;
  multiple: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  below_floor: number;
  live_size: number;
  named_size: number;
  comparable_sample: number;
  overall_multiple: number;
  categories: MultipleRow[];
  chains: MultipleRow[];
  rows: BoardRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const DERIVED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/;

function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n));
}

function slugCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The median of a numeric list, or null when it is empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function pushTo(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol records no token only when market cap, CoinGecko id and symbol are all absent. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A record that is a wrapped, staked, bridged, versioned or exchange product rather than a launch. */
export function structureFactor(p: SnapshotProtocol, model: ModelConstants = MODEL): StructureInfo {
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) {
    return {
      kind: 'wrapped or staked product',
      factor: model.structure_wrapped,
      derivative: true,
      note: 'wrapped or staked product of an asset whose token already trades',
    };
  }
  if (p.category !== null && DERIVED_CATEGORIES.has(p.category)) {
    return {
      kind: `${p.category.toLowerCase()} record`,
      factor: model.structure_derivative,
      derivative: true,
      note: `a ${p.category.toLowerCase()} record is usually a product of a token that already trades`,
    };
  }
  if (VERSIONED.test(p.name)) {
    return {
      kind: 'versioned pool',
      factor: model.structure_derivative,
      derivative: true,
      note: 'a versioned pool carries the name of an existing protocol line',
    };
  }
  if (EXCHANGE_PREFIX.test(p.name)) {
    return {
      kind: 'exchange product',
      factor: model.structure_derivative,
      derivative: true,
      note: 'an exchange product usually shares the exchange token rather than launching one',
    };
  }
  return {
    kind: 'independent protocol',
    factor: 1,
    derivative: false,
    note: 'an independent protocol record with no token in any of its three token fields',
  };
}

/** The robust medians the model uses, computed from the snapshot's own mcap/TVL ratios. */
export function computeComparables(snapshot: Snapshot, model: ModelConstants = MODEL): Comparables {
  const ratios: number[] = [];
  const byCategory = new Map<string, number[]>();
  const byChain = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio < model.ratio_floor || ratio > model.ratio_cap) continue;
    ratios.push(ratio);
    pushTo(byCategory, p.category ?? 'Other', ratio);
    for (const chain of new Set(p.chains)) pushTo(byChain, chain, ratio);
  }
  const overall = median(ratios) ?? 0.2;
  const catLow = Math.max(model.cat_abs_low, overall * model.cat_low_ratio);
  const catHigh = Math.min(model.cat_abs_high, overall * model.cat_high_ratio);
  const categories = new Map<string, MultipleStat>();
  const chains = new Map<string, MultipleStat>();
  for (const [key, values] of byCategory) {
    const med = median(values);
    if (med === null) continue;
    const shrunk = (values.length * med + model.shrink_k * overall) / (values.length + model.shrink_k);
    categories.set(key, { count: values.length, median: med, multiple: clamp(shrunk, catLow, catHigh) });
  }
  for (const [key, values] of byChain) {
    const med = median(values);
    if (med === null) continue;
    const shrunk = (values.length * med + model.shrink_k * overall) / (values.length + model.shrink_k);
    chains.set(key, { count: values.length, median: med, multiple: shrunk });
  }
  return { overall, sample: ratios.length, categories, chains };
}

function categoryStat(comps: Comparables, category: string | null): MultipleStat {
  const found = comps.categories.get(category ?? 'Other');
  return found ?? { count: 0, median: null, multiple: comps.overall };
}

/** The live-token comparables: records that already carry a market cap, by market cap. */
export function liveRows(snapshot: Snapshot, limit = 160): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, limit)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      change_7d: p.change_7d,
      ratio: p.tvl_usd > 0 ? (p.mcap_usd as number) / p.tvl_usd : 0,
    }));
}

/** One protocol's full model, including every multiplier, the confidence score and its parts. */
export function valueProtocol(p: SnapshotProtocol, snapshot: Snapshot, comps: Comparables, model: ModelConstants = MODEL): ValueModel {
  const cat = categoryStat(comps, p.category);
  const categoryMultiple = cat.multiple;

  const chainSet = [...new Set(p.chains)];
  let logSum = 0;
  let chainWithData = 0;
  let chainComparables = 0;
  for (const chain of chainSet) {
    const stat = comps.chains.get(chain);
    if (stat === undefined) continue;
    chainComparables += stat.count;
    if (stat.multiple > 0 && comps.overall > 0) {
      logSum += Math.log(stat.multiple / comps.overall);
      chainWithData++;
    }
  }
  const chainFactor = chainWithData === 0 ? 1 : clamp(Math.exp(logSum / chainWithData), model.chain_low, model.chain_high);

  const depth = clamp(Math.log10(Math.max(p.tvl_usd, 1_000_000) / 1_000_000) / 3, 0, 1);
  const breadth = clamp(chainSet.length / 5, 0, 1);
  const quality = model.quality_base + model.quality_depth * depth + model.quality_breadth * breadth;
  const chainQuality = clamp(chainFactor * quality, 0.6, 1.8);

  const structure = structureFactor(p, model);
  const qualityAdjustment = Math.max(0.001, chainQuality * structure.factor);

  const rawGrowth = p.change_7d ?? 0;
  const growthPct = clamp(rawGrowth, model.growth_floor, model.growth_cap);
  const growthMultiplier = 1 + (growthPct / 100) * model.growth_weight;

  const age = ageDays(snapshot.as_of, p.listed_at);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMultiplier = model.maturity_floor + (clamp(ageForModel, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;

  const raw = p.tvl_usd * categoryMultiple * qualityAdjustment * growthMultiplier * maturityMultiplier;
  const implied = Math.round(clamp(raw, model.value_floor, model.value_ceiling));

  const catPart = 32 * (cat.count / (cat.count + 5));
  const chainPart = 18 * Math.min(1, chainComparables / 30);
  const agePart = age === null ? 0 : 8;
  const growthPart = p.change_7d === null ? 0 : 7;
  const independencePart = structure.derivative ? -20 : 15;
  const confidence = Math.round(clamp(20 + catPart + chainPart + agePart + growthPart + independencePart, 5, 97));
  const confidenceLabel = confidence >= 75 ? 'High' : confidence >= 50 ? 'Medium' : 'Low';

  return {
    category_multiple: categoryMultiple,
    category_comparables: cat.count,
    category_median: cat.median,
    chain_factor: chainFactor,
    chain_comparables: chainComparables,
    quality_factor: quality,
    chain_quality: chainQuality,
    structure_factor: structure.factor,
    structure_kind: structure.kind,
    structure_derivative: structure.derivative,
    structure_note: structure.note,
    quality_adjustment: qualityAdjustment,
    growth_pct: growthPct,
    growth_multiplier: growthMultiplier,
    maturity_multiplier: maturityMultiplier,
    age_days: age,
    raw_value: Math.round(raw),
    tie_adjustment: 0,
    implied_value_usd: implied,
    confidence,
    confidence_label: confidenceLabel,
    confidence_parts: {
      base: 20,
      category: Math.round(catPart * 10) / 10,
      chain: Math.round(chainPart * 10) / 10,
      age: agePart,
      growth: growthPart,
      independence: independencePart,
      chain_comparables: chainComparables,
    },
  };
}

function compactUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'n/a';
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

function pct(n: number | null): string {
  if (n === null) return 'not reported';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** A farm step clamped to the gate's 40..220 character window, on a word boundary where possible. */
function clampStep(text: string): string {
  let step = text.replace(/\s+/g, ' ').trim();
  if (step.length > 220) {
    const head = step.slice(0, 217);
    const at = head.lastIndexOf(' ');
    step = `${(at > 180 ? head.slice(0, at) : head).trimEnd()}...`;
  }
  if (step.length < 40) step = `${step} Check the protocol's official page first.`;
  if (step.length < 40) step = `${step} Verify the contract and the team before you deposit.`;
  return step.slice(0, 220);
}

function capitalFor(tvl: number): number {
  if (tvl >= 5_000_000_000) return 500;
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 100_000_000) return 100;
  if (tvl >= 10_000_000) return 50;
  return 25;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

function chainLabel(p: SnapshotProtocol): string {
  if (p.chains.length === 0) return 'its main chain';
  if (p.chains.length === 1) return p.chains[0]!;
  return `${p.chains[0]} and ${p.chains[1]}`;
}

type FarmKind =
  | 'lending'
  | 'dex'
  | 'perps'
  | 'yield'
  | 'cdp'
  | 'chain'
  | 'rwa'
  | 'allocator'
  | 'staking'
  | 'bridge'
  | 'insurance'
  | 'prediction'
  | 'stable'
  | 'other';

const FARM_ASSETS = ['USDC', 'USDT', 'ETH', 'wstETH', 'WBTC', 'DAI'];
const FARM_PAIRS = ['USDC/ETH', 'USDC/WBTC', 'ETH/wstETH', 'WBTC/USDC', 'DAI/USDC'];
const FARM_FEES = ['0.05%', '0.30%', '1.00%'];
const FARM_RATIOS = ['150%', '175%', '200%'];
const FARM_COLLATERAL = ['ETH', 'wstETH', 'WBTC', 'USDC'];
const FARM_STABLES = ['USDC', 'USDT', 'DAI'];

function slugSeed(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pickVariant<T>(variants: T[], seed: number, salt: number): T {
  return variants[((seed + Math.imul(salt, 0x9e3779b1)) >>> 0) % variants.length]!;
}

function pickStep<T>(variants: T[], index: number, salt: number): T {
  return variants[(index + salt) % variants.length]!;
}

function farmKind(category: string | null): FarmKind {
  const c = (category ?? '').toLowerCase();
  if (c.includes('allocator')) return 'allocator';
  if (c.includes('lend') || c.includes('collateral') || c.includes('uncollateralized')) return 'lending';
  if (c.includes('dex')) return 'dex';
  if (c.includes('perp') || c.includes('derivative') || c.includes('basis') || c.includes('option') || c.includes('synthetic')) return 'perps';
  if (c.includes('cdp')) return 'cdp';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('chain')) return 'chain';
  if (c.includes('rwa') || c.includes('real world')) return 'rwa';
  if (c.includes('curator') || c.includes('yield') || c.includes('vault') || c.includes('farm')) return 'yield';
  if (c.includes('stak') || c.includes('restak') || c.includes('anchor btc') || c.includes('decentralized btc')) return 'staking';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('stable')) return 'stable';
  return 'other';
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string, seed: number, index: number): string {
  const name = p.name;
  const tvl = compactUsd(p.tvl_usd);
  const asset = pickVariant(FARM_ASSETS, seed, 11);
  const other = pickVariant(FARM_ASSETS, seed, 12);
  const pair = pickVariant(FARM_PAIRS, seed, 13);
  const fee = pickVariant(FARM_FEES, seed, 14);
  const ratio = pickVariant(FARM_RATIOS, seed, 15);
  const collateral = pickVariant(FARM_COLLATERAL, seed, 16);
  const stable = pickVariant(FARM_STABLES, seed, 17);
  switch (farmKind(p.category)) {
    case 'lending':
      return pickStep([
        `Supply $${capital} of ${asset} to ${name} on ${chain} (${tvl} TVL), borrow a smaller amount of ${other}, and keep the health factor above 2 while watching utilization.`,
        `On ${name}, a ${tvl} venue on ${chain}, supply $${capital} of ${asset} and borrow ${other} against it, holding the health factor above 2 with a liquidation check before each rate change.`,
        `Deposit $${capital} of ${asset} into ${name} on ${chain}, a ${tvl} record, take one small ${other} loan, and prove the position stays above a 2.0 health factor in the app.`,
      ], index, 21);
    case 'dex':
      return pickStep([
        `Provide $${capital} of ${pair} liquidity on ${name} at the ${fee} fee tier on ${chain} (${tvl} TVL), then note the impermanent-loss risk before the first week is out.`,
        `${name} on ${chain}: LP $${capital} into the ${pair} ${fee} pool of a ${tvl} venue, record the fee tier and impermanent-loss exposure, and avoid the highest-yield farm until it holds two weeks.`,
        `Add $${capital} of ${pair} liquidity through ${name} on ${chain}, a ${tvl} venue, quote the ${fee} fee tier and the impermanent-loss range, and leave the position untouched for a full epoch.`,
      ], index, 22);
    case 'perps':
      return pickStep([
        `Open one small hedge on ${name} with $${capital} of margin on ${chain} (${tvl} TVL), keep leverage under 2x, and treat oracle and liquidation risk as the main hazards.`,
        `Use ${name}, a ${tvl} venue on ${chain}, for a single hedge sized at $${capital}, cap leverage at 2x, and check the oracle and funding rate before every roll.`,
        `Place a $${capital} hedge through ${name} on ${chain}, a ${tvl} book, stay below 2x leverage, and write down the liquidation price and oracle source first.`,
      ], index, 23);
    case 'yield':
      return pickStep([
        `Deposit $${capital} into ${name}'s flagship vault on ${chain} (${tvl} TVL), read the curator fee and lock-up, and skip vaults whose TVL is falling quickly.`,
        `Put $${capital} into the main ${name} vault on ${chain}, a ${tvl} book, confirm the curator fee, the lock-up and the withdrawal queue before the deposit clears.`,
        `On ${name}, fund $${capital} of the flagship vault on ${chain} (${tvl} TVL), note the curator fee and lock-up, and avoid any vault with a falling TVL trend.`,
      ], index, 24);
    case 'cdp':
      return pickStep([
        `Mint $${capital} of ${stable} against ${collateral} on ${name} at a ${ratio} collateral ratio on ${chain} (${tvl} TVL), and keep a buffer before the liquidation line.`,
        `Open a ${name} CDP on ${chain}, a ${tvl} book: lock ${collateral}, mint $${capital} of ${stable}, and hold the collateral ratio at ${ratio} or better.`,
        `Use ${name} on ${chain} to lock ${collateral} and mint $${capital} of ${stable} at ${ratio}, with the ${tvl} record and a plan to repay before the ratio nears liquidation.`,
      ], index, 25);
    case 'chain':
      return pickStep([
        `Bridge a small $${capital} to ${chain} through ${name} (${tvl} TVL), then bridge-and-stake part of it, and name the bridge risk before you send a larger amount.`,
        `Move $${capital} onto ${chain} with ${name}, a ${tvl} chain, stake a slice through its native app, and treat bridge and validator risk as the binding constraints.`,
        `Test ${name} with $${capital}: bridge to ${chain}, a ${tvl} network, bridge-and-stake a small part, and record the bridge risk and withdrawal delay first.`,
      ], index, 26);
    case 'rwa':
      return pickStep([
        `Mint $${capital} of ${name}'s asset on ${chain} (${tvl} TVL), then test the redeem path and note the gating such as KYC, whitelist or lock-up before adding size.`,
        `On ${name}, a ${tvl} book on ${chain}, mint $${capital}, walk the redeem route once, and write down the gating and settlement delay that apply to your jurisdiction.`,
        `Use ${name}'s mint path for $${capital} on ${chain}, a ${tvl} record, confirm the redemption gate and issuer terms, and keep the position small while the record still shows no token.`,
      ], index, 27);
    case 'allocator':
      return pickStep([
        `Deposit $${capital} with ${name} on ${chain} (${tvl} TVL), name its fee model such as management, performance or both, and check how the allocator reports NAV before scaling.`,
        `Allocate $${capital} through ${name} on ${chain}, a ${tvl} book, read the management and performance fees, and confirm how the allocator marks positions before you add more.`,
        `Place $${capital} with the ${name} allocator on ${chain} (${tvl} TVL), quote its fee model and reporting cadence, and avoid any strategy whose NAV is not published.`,
      ], index, 28);
    case 'staking':
      return pickStep([
        `Stake $${capital} of ${chain}'s native asset through ${name} (${tvl} TVL), keep the receipt token, and record slashing and validator risk before adding more.`,
        `Use ${name} on ${chain}, a ${tvl} staking book, to stake $${capital}, hold the liquid receipt, and read the slashing and unbonding terms before the first reward snapshot.`,
        `Stake $${capital} through ${name} on ${chain}, a ${tvl} book, note the receipt token and unbonding period, and watch validator concentration as the main risk.`,
      ], index, 29);
    case 'bridge':
      return pickStep([
        `Route a small $${capital} through ${name} to ${chain} (${tvl} TVL), confirm the bridge risk and withdrawal delay, and only then move a larger amount.`,
        `Send $${capital} across ${name} into ${chain}, a ${tvl} bridge, test the return path, and record the bridge risk and any wrapped-asset exposure before scaling.`,
        `Bridge $${capital} with ${name} onto ${chain} (${tvl} TVL), name the bridge risk and destination gas needs, and keep the first transfer deliberately small.`,
      ], index, 30);
    case 'insurance':
      return pickStep([
        `Buy $${capital} of cover from ${name} on ${chain} (${tvl} TVL), check the deductible and the covered protocol, and treat the cover itself as the position to hold.`,
        `Spend $${capital} on ${name} cover for a ${chain} position, a ${tvl} book, confirm the deductible and exclusions, and hold the policy through its full term.`,
      ], index, 31);
    case 'prediction':
      return pickStep([
        `Fund $${capital} on ${name} on ${chain} (${tvl} TVL), place one position in a liquid market, and check the resolution source before the event closes.`,
        `Use $${capital} on ${name}, a ${tvl} market on ${chain}, for one liquid position, read the resolution rules, and accept that it can go to zero.`,
      ], index, 32);
    case 'stable':
      return pickStep([
        `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} (${tvl} TVL), check the collateral ratio and peg history, and avoid leverage on the stable.`,
        `Use ${name} on ${chain}, a ${tvl} stable book, to mint $${capital} of its stable, confirm the collateral ratio and peg record, and keep the position unlevered.`,
      ], index, 33);
    default:
      return pickStep([
        `Use ${name}'s own deposit path on ${chain} for $${capital} (${tvl} TVL), confirm the contract and the fee, and keep the first position small enough to exit.`,
        `Deposit $${capital} through ${name}'s official app on ${chain}, a ${tvl} record, read the fee and withdrawal terms, and check the contract before you sign.`,
        `Follow ${name}'s own deposit flow on ${chain} with $${capital}, a ${tvl} record, note the fee and lock-up, and verify the contract address on the protocol site first.`,
      ], index, 34);
  }
}

/** A protocol's farm plan: six concrete steps, four at the very least, each inside 40..220 characters. */
export function farmSteps(p: SnapshotProtocol, value: ValueModel, index = 0): string[] {
  const chain = chainLabel(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(value.age_days);
  const seed = slugSeed(p.slug);
  const ageText = value.age_days === null ? 'an unrecorded age' : `${value.age_days} days`;
  const tvl = compactUsd(p.tvl_usd);
  const week = pct(p.change_7d);
  const trend = p.change_7d === null ? 'flat' : p.change_7d >= 0 ? 'rising' : 'falling';
  const chainCount = p.chains.length === 0 ? 1 : new Set(p.chains).size;
  const mcapText = p.mcap_usd === null ? 'no listed market cap' : `a ${compactUsd(p.mcap_usd)} market cap`;
  const stop = 12 + (seed % 9);
  const stopContext =
    p.change_7d === null
      ? ' with no 7d print to lean on'
      : p.change_7d < 0
        ? ` (this week is ${week}; the cumulative move would be about -${Math.round(Math.abs(p.change_7d) + stop)}%)`
        : ` after a ${week} week`;

  const verify = pickVariant([
    `Check ${p.name}'s own site and DefiLlama first: market cap, CoinGecko id and symbol must all stay empty, and this plan starts on ${chain}.`,
    `Before depositing, open ${p.name}'s official site and its DefiLlama page and confirm the record still names no token in any of its three fields; start on ${chain}.`,
    `Open ${p.name}'s app and DefiLlama together and verify that market cap, CoinGecko id and symbol are still blank; begin on ${chain}.`,
    `Start on ${p.name}'s own site and DefiLlama: the record has to keep showing no token in the market-cap, CoinGecko-id and symbol fields, and you begin on ${chain}.`,
  ], index, 1);

  const diligence = value.structure_derivative
    ? pickVariant([
        `${p.name} is a ${value.structure_kind}, but the numbers are TVL ${tvl}, 7d ${week}, ${ageText} on record and ${chainCount} chain(s); check whether a parent token already trades before trusting the trend.`,
        `Diligence on ${p.name}: ${tvl} TVL, ${week} over 7d, ${ageText} old, ${chainCount} chain(s) and ${mcapText}; as a ${value.structure_kind}, trace the parent token and the next snapshot together.`,
        `For the ${value.structure_kind} record ${p.name}, weigh ${tvl} TVL and ${week} over 7d against ${ageText} of history and ${chainCount} chain(s); a parent token already trading would disqualify the plan.`,
        `${p.name} shows ${tvl} TVL and ${week} over 7d across ${chainCount} chain(s) with ${ageText} on record; because it is a ${value.structure_kind}, check the parent token and any fresh snapshot before adding.`,
      ], index, 3)
    : pickVariant([
        `Diligence on ${p.name}: TVL ${tvl}, 7d ${week}, ${ageText}, ${chainCount} chain(s) and ${mcapText}; a snapshot that reverses the trend or drops a chain is the one that disqualifies it.`,
        `Watch ${p.name}'s next snapshot: ${tvl} TVL, ${week} over 7d, ${ageText} on record, ${chainCount} chain(s) and ${mcapText}; a break below that TVL would make this claim stale.`,
        `For ${p.name}, note ${tvl} TVL, a ${week} week, ${ageText} of history, ${chainCount} chain(s) and ${mcapText}; the diligence test is whether the next print holds the trend and the chain set.`,
        `${p.name} shows ${tvl} TVL and ${week} over 7d across ${chainCount} chain(s) with ${ageText} on record and ${mcapText}; any fresh snapshot below the current TVL or missing a chain should reset the plan.`,
      ], index, 3);

  const horizon = pickVariant([
    `Hold about ${hold} days for a record ${ageText} old with a ${trend} week; the snapshot rule is two weekly prints at or above ${tvl} before scaling, and an exit if a token appears.`,
    `Plan a ${hold}-day hold: ${ageText} of history and a ${trend} seven-day move argue for waiting for two weekly snapshots near ${tvl} before adding, and leaving on any token.`,
    `Set the horizon at ${hold} days because the record is ${ageText} old and the week is ${trend}; only scale after two snapshots hold ${tvl}, and exit the moment a token field fills.`,
    `Use a ${hold}-day horizon against ${ageText} of history and a ${trend} trend; the rule is two weekly snapshots at ${tvl} or better before adding, with a token in the record as the exit.`,
  ], index, 4);

  const exit = pickVariant([
    `Exit and claim only on ${p.name}'s official app: revoke approvals after each withdrawal, budget for gas and any withdrawal fee, and recheck the record before you redeposit.`,
    `When leaving ${p.name}, claim from its own app, clear token approvals, account for withdrawal fees and gas, and re-open the DefiLlama record before any redeposit.`,
    `Take rewards from ${p.name}'s official app, never a third-party claim link; revoke approvals, price the exit fees, and confirm the token fields are still empty afterward.`,
    `Close the ${p.name} position in the protocol app, reset approvals on ${chain}, keep a note of fees paid, and recheck that the record still shows no token before returning.`,
  ], index, 5);

  const stopStep = pickVariant([
    `Hard stop: if ${p.name}'s TVL falls another ${stop}% in a week${stopContext}, unwind rather than average down, and size the position so that stop is affordable.`,
    `Set the unwind trigger at a ${stop}% weekly TVL drop for ${p.name}${stopContext}; a paused withdrawal counts too, so keep the position small enough to exit in one go.`,
    `Treat a ${stop}% fall in ${p.name}'s TVL over seven days as the hard stop${stopContext}, and unwind on a withdrawal pause instead of adding to a losing position.`,
    `If ${p.name} gives back ${stop}% of TVL in a week${stopContext}, exit and reassess; never average down into a falling record that still shows no token.`,
  ], index, 6);

  return [verify, actionFor(p, capital, chain, seed, index), diligence, horizon, exit, stopStep].map(clampStep);
}

function whatWouldChange(p: SnapshotProtocol, value: ValueModel): string[] {
  const medianText = value.category_median === null ? 'no raw category median' : `a raw median of ${value.category_median.toFixed(2)}x`;
  const repricing =
    value.category_median !== null && value.category_multiple > 0
      ? `; repricing at that raw median would multiply the claim by about ${(value.category_median / value.category_multiple).toFixed(1)}x`
      : '';
  const out: string[] = [
    `TVL is ${compactUsd(p.tvl_usd)} and the category multiple is ${value.category_multiple.toFixed(2)}x from ${value.category_comparables} comparable token record${value.category_comparables === 1 ? '' : 's'} with ${medianText}; a 10% TVL move shifts the claim about 10%${repricing}.`,
    `Seven-day growth is ${pct(p.change_7d)}; a 20-point swing moves the implied value by about ${Math.round(MODEL.growth_weight * 20)}% because growth is weighted at ${MODEL.growth_weight}.`,
    `The chain factor is ${value.chain_factor.toFixed(2)}x from ${value.chain_comparables} chain sample point${value.chain_comparables === 1 ? '' : 's'}, and the maturity multiplier stops rising at ${MODEL.maturity_days} days.`,
    `If a market cap, CoinGecko id or symbol appears in the record, this protocol leaves the pre-token board and joins the live-token comparables.`,
  ];
  if (value.structure_derivative) {
    out.push(`This is a ${value.structure_kind}, so the ${value.structure_factor.toFixed(2)}x structure factor is the largest discount in the model; a parent token may already trade.`);
  }
  return out;
}

/** The protocols the board ranks, strongest first, with ranks 1..n and strictly distinct integer values. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const comps = computeComparables(snapshot, model);
  const scored = snapshot.protocols
    .filter(isPreToken)
    .map((p) => ({ p, value: valueProtocol(p, snapshot, comps, model) }));
  scored.sort(
    (a, b) =>
      b.value.implied_value_usd - a.value.implied_value_usd ||
      b.p.tvl_usd - a.p.tvl_usd ||
      slugCompare(a.p.slug, b.p.slug),
  );

  const n = scored.length;
  const watchlist = new Set(snapshot.watchlist);
  let previous = Number.POSITIVE_INFINITY;
  const rows: BoardRow[] = [];
  for (let i = 0; i < n; i++) {
    const entry = scored[i]!;
    const floorForIndex = model.value_floor + (n - 1 - i);
    const value = Math.max(floorForIndex, Math.min(entry.value.implied_value_usd, previous - 1));
    const tie = value - entry.value.implied_value_usd;
    previous = value;
    const structure = structureFactor(entry.p, model);
    const modelValue: ValueModel = { ...entry.value, tie_adjustment: tie, implied_value_usd: value };
    rows.push({
      rank: i + 1,
      slug: entry.p.slug,
      name: entry.p.name,
      category: entry.p.category,
      chains: entry.p.chains,
      tvl_usd: entry.p.tvl_usd,
      change_7d: entry.p.change_7d,
      mcap_usd: entry.p.mcap_usd,
      listed_at: entry.p.listed_at,
      gecko_id: entry.p.gecko_id,
      symbol: entry.p.symbol,
      token_status: 'pre-token',
      watchlist: watchlist.has(entry.p.slug),
      age_days: entry.value.age_days,
      implied_value_usd: value,
      confidence: entry.value.confidence,
      confidence_label: entry.value.confidence_label,
      structure,
      model: modelValue,
      farm_steps: farmSteps(entry.p, modelValue, i),
      what_would_change: whatWouldChange(entry.p, modelValue),
    });
  }
  return rows;
}

function multipleRows(map: Map<string, MultipleStat>): MultipleRow[] {
  return [...map.entries()]
    .map(([key, stat]) => ({ key, count: stat.count, median: stat.median, multiple: stat.multiple }))
    .sort((a, b) => b.count - a.count || slugCompare(a.key, b.key));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const comps = computeComparables(snapshot, model);
  const board = buildBoard(snapshot, model);
  const watchlist = new Set(snapshot.watchlist);
  const live = liveRows(snapshot);
  const namedSize = snapshot.protocols.filter(
    (p) => p.mcap_usd === null && (p.gecko_id !== null || p.symbol !== null),
  ).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watchlist.has(r.slug)).length,
    below_floor: board.filter((r) => r.tvl_usd < snapshot.floor_usd).length,
    live_size: snapshot.protocols.filter((p) => p.mcap_usd !== null).length,
    named_size: namedSize,
    comparable_sample: comps.sample,
    overall_multiple: comps.overall,
    categories: multipleRows(comps.categories),
    chains: multipleRows(comps.chains),
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 300) return `the board has ${board.length} rows, fewer than the 300 this entry promises`;
  if (board.length > 4000) return `the board has ${board.length} rows, more than the gate's 4000`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < board.length; i++) {
    if (board[i]!.rank !== i + 1) return `rank ${i + 1} is ${board[i]!.rank}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd >= board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} (${board[i]!.slug}) does not rank strictly below row ${i} (${board[i - 1]!.slug})`;
    }
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd < 1000 || r.implied_value_usd > 1e14) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 4 || r.farm_steps.length > 6) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const step of r.farm_steps) {
      if (step.length < 40 || step.length > 220) return `${r.slug} has a farm step of ${step.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
