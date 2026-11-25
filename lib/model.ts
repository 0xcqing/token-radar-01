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

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const name = p.name;
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('uncollateralized')) {
    return `Supply $${capital} of USDC to ${name} on ${chain}, borrow a small amount, and keep the health factor above 1.5; rising utilization is the risk to watch.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged') || c.includes('farm') || c.includes('liquidity')) {
    return `Add $${capital} of USDC-ETH liquidity to ${name}'s deepest pool on ${chain}, check the fee tier and impermanent loss, and leave it for several weeks.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name}, then swap or deposit on the destination chain; test with a small amount because bridge risk is high.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of ${chain}'s native asset through ${name}, keep the receipt token, and watch slashing and validator risk before adding more.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option') || c.includes('synthetic')) {
    return `Deposit $${capital} of USDC margin on ${name}, open one small hedge or option, and keep leverage under 2x; liquidation and oracle risk are the hazards.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} of USDC on ${name}, place one position in a liquid market, and check the resolution source before betting; the position can go to zero.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) {
    return `Deposit $${capital} of USDC into ${name}'s flagship vault on ${chain}, read the curator fee and lock-up, and avoid vaults whose TVL is falling fast.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}, check the collateral ratio and peg history, and avoid leverage on the stable.`;
  }
  if (c.includes('rwa') || c.includes('reserve')) {
    return `Mint $${capital} of ${name}'s yield asset on ${chain}, confirm the issuer and redemption terms, and keep the position small while the record shows no token.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain}, check the deductible and the covered protocol, and treat the cover itself as the position to hold.`;
  }
  if (c.includes('chain')) {
    return `Bridge or deposit $${capital} of USDC onto ${chain}, use ${name}'s native app for one swap and one stake, and keep gas funds on both sides of the bridge.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain}, keep the position open, and check the contract and TVL trend before adding more.`;
}

/** A protocol's farm plan: six concrete steps, four at the very least, each inside 40..220 characters. */
export function farmSteps(p: SnapshotProtocol, value: ValueModel): string[] {
  const chain = chainLabel(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(value.age_days);
  const ageText = value.age_days === null ? 'an unrecorded period' : `${value.age_days} days`;
  const steps = [
    `Confirm ${p.name} still records no token on its own site and DefiLlama, then use a fresh wallet funded only with money you can lose; a launch is not promised.`,
    actionFor(p, capital, chain),
    `Return weekly to make one qualifying action, such as a deposit, borrow, swap or vote, and watch ${p.name}'s official points or rewards page for its snapshot rule.`,
    `Hold for at least ${hold} days across two or more weekly snapshots; ${p.name} has run ${ageText} while the record shows no token, so patience is the edge, not a guarantee.`,
    `Before withdrawing, claim any reward only from ${p.name}'s official app, never pay a fee to claim, log the wallet and dates, and recheck the record for a token before adding size.`,
  ];
  if (value.structure_derivative) {
    steps.push(`This record is a ${value.structure_kind}, so a parent protocol may already have a token; confirm the parent and treat any points program as speculative.`);
  } else {
    steps.push(`Set a hard stop: if ${p.name}'s TVL falls more than 30% in a week or withdrawals pause, unwind rather than average down, and keep the position small.`);
  }
  return steps.map(clampStep).slice(0, 6);
}

function whatWouldChange(p: SnapshotProtocol, value: ValueModel): string[] {
  const out: string[] = [
    `TVL is ${compactUsd(p.tvl_usd)} and the category multiple is ${value.category_multiple.toFixed(2)}x from ${value.category_comparables} comparable token record${value.category_comparables === 1 ? '' : 's'}; a 10% move in either moves the value about 10%.`,
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
      farm_steps: farmSteps(entry.p, modelValue),
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
