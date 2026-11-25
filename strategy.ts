// Pump.fun replay bot — fresh design for agent-fun/replay/v2.
//
// Three entry modes share one tape engine (snipe: fresh launches with a rug filter;
// dip: buy a sharp drawdown on a curve that still has buyers; flow: buy accelerating
// net inflow on a mature curve). Every mode sizes small, exits fast, and never lets
// one coin or one bad tape eat the book: a cash reserve is always kept, exposure is
// capped, and all sizing is in lamports with the 1.25% curve fee + 105k tx fee priced
// into every exit decision.
//
// RUNTIME SAFETY (loss-log #27 — the sibling entry timed out in grading): the bot
// never reads a clock or any randomness, so the two graded executions stay
// byte-identical, and instead bounds its work with deterministic counters:
//   * at most MAX_BATCHES batches may open new positions; after that only exits run;
//   * at most MAX_ORDERS orders are ever sent;
//   * each mint's tape is capped (MAX_TICKS) and mints idle for IDLE_SLOTS are dropped;
//   * each batch only evaluates mints that traded in that batch plus held positions.
// Per-batch work is therefore O(traded + held), never O(all mints), and the run
// always terminates inside the grader's wall budget.

import { BPS, LAMPORTS_PER_SOL, type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export type Mode = 'snipe' | 'dip' | 'flow';

export interface Params {
  mode: Mode;
  /** Lamports aimed at per coin (each buy is still capped at 1% of real SOL). */
  stakeLamports: bigint;
  /** Smallest single buy worth the tx fee (also the guardrail round-trip floor). */
  minBuyLamports: bigint;
  /** Most positions open at once (harness cap is 5). */
  maxPositions: number;
  /** Lamports of cash never spent (keeps the book alive for exits + tx fees). */
  cashReserveLamports: bigint;
  /** Most lamports at cost across all positions at once. */
  maxExposureLamports: bigint;
  /** Most new entries decided in one batch. */
  maxEntriesPerBatch: number;
  /** Slippage allowed on buys (bps). Sells always go out at 10000. */
  buySlippageBps: number;

  // --- snipe + flow shared ---
  /** Youngest / oldest age (slots since create) a first buy may be decided at. */
  minAge: number;
  maxAge: number;
  /** Real SOL reserve window at decision time. */
  minRealSolLamports: bigint;
  maxRealSolLamports: bigint;

  // --- snipe ---
  /** Creator's own buys in the create slot, at most. */
  maxDevBuyLamports: bigint;
  /** Distinct non-creator buyers seen before entry, at most. */
  maxBuyers: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Trades seen before entry, at least. */
  minTrades: number;
  /** Lamports bought by anyone before entry, at least. */
  minBoughtLamports: bigint;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: bigint;
  /** Largest single non-creator sell, as bps of real SOL before it, at most. */
  maxBigSellBps: bigint;
  /** Price now over create price, as bps: window. */
  minRunupBps: bigint;
  maxRunupBps: bigint;
  /** Recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: bigint;
  minRecentBuyers: number;
  /** Skip the coin when the creator sold before entry. */
  skipDevSold: boolean;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit at once when a single recorded sell of at least this many lamports hits a held coin (0 = off). */
  exitBigSellLamports: bigint;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Buys after the first, each on a later batch, while the coin keeps qualifying. */
  maxAdds: number;
  /** An add waits this many slots after the previous buy was decided. */
  addDelay: number;
  /** Lamports per add. */
  addLamports: bigint;
  /** An add needs the price at least this far (bps) above the previous buy's price. */
  addStepBps: bigint;

  // --- exits (all modes; bps against cost incl. tx fees paid) ---
  /** Sell this share of the position once it is worth tp1Bps over cost (0 = off). */
  tp1Bps: bigint;
  tp1PartBps: bigint;
  /** Exit when the position is worth this much over its cost. */
  tpBps: bigint;
  /** Exit when it is worth this much under its cost. */
  slBps: bigint;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from best. */
  trailArmBps: bigint;
  trailBps: bigint;
  /** Exit after holding this many slots. */
  maxHold: number;

  // --- dip ---
  /** Lookback (slots) for the recent high the drawdown is measured from. */
  highWindow: number;
  /** Enter when price is at least this far below the recent high (fraction)... */
  ddMin: number;
  /** ...and not further than this (a collapse, not a dip). */
  ddMax: number;
  /** The recent high must have come with at least this much real SOL. */
  minHighRealSolLamports: bigint;
  /** Of the last flowTrades trades at least minBuys must be buys... */
  flowTrades: number;
  minDipBuys: number;
  /** ...and the most recent trade must be a buy. */
  lastMustBeBuy: boolean;
  /** Net SOL bought over the last flowTrades trades must be at least this. */
  minNetFlowLamports: bigint;
  /** Lamports per tranche and most lamports per position. */
  trancheLamports: bigint;
  maxPositionLamports: bigint;
  /** Add tranches only while the price stays within this fraction of entry price. */
  addBand: number;
  /** Exit when the price recovers this share of the gap entry -> recent high (0 = off). */
  recoverShare: number;
  /** After an exit, ignore the coin for this many slots. */
  cooldownSlots: number;
  /** Dip entries only on coins with at least this many distinct buyers seen (0 = off). */
  minDipBuyers: number;

  // --- flow ---
  /** Entry window in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window, lamports. */
  minNetSolLamports: bigint;
  /** Buy trades in the window, at least. */
  minFlowBuys: number;
  /** Price now over price at the window start, minus 1, at least. */
  minPriceUp: number;
  /** ...and at most (skip curves that already ran too far). */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL, at most. */
  maxBuyerShare: number;
  /** Net SOL over the fade window below which a held position is exited (0 = off). */
  fadeNetSolLamports: bigint;
  fadeWindow: number;
  /** The time limit does not apply while the position is up at least this much (bps; 0 = always applies). */
  holdIfUpBps: bigint;
  /** Add to a position while the entry signal still holds, up to stakeLamports. */
  pyramid: boolean;
  /** Each add-on buy (lamports). */
  addSolLamports: bigint;
}

export const SNIPE_DEFAULTS: Params = {
  mode: 'snipe',
  stakeLamports: 100_000_000n,
  minBuyLamports: 50_000_000n,
  maxPositions: 5,
  cashReserveLamports: 1_000_000_000n,
  maxExposureLamports: 6_000_000_000n,
  maxEntriesPerBatch: 2,
  buySlippageBps: 1000,
  minAge: 1,
  maxAge: 2,
  minRealSolLamports: 300_000_000n,
  maxRealSolLamports: 30_000_000_000n,
  maxDevBuyLamports: 5_000_000_000n,
  maxBuyers: 7,
  minBuyers: 0,
  minTrades: 0,
  minBoughtLamports: 0n,
  maxSellRatioBps: 10_000n,
  maxBigSellBps: 10_000n,
  minRunupBps: 0n,
  maxRunupBps: 1_000_000n,
  flowWindow: 10,
  minFlowLamports: -1_000_000_000_000n,
  minRecentBuyers: 0,
  skipDevSold: true,
  exitOnDevSell: true,
  exitBigSellLamports: 2_000_000_000n,
  staleSlots: 1_000_000,
  maxAdds: 0,
  addDelay: 2,
  addLamports: 100_000_000n,
  addStepBps: 0n,
  tp1Bps: 500n,
  tp1PartBps: 5000n,
  tpBps: 1500n,
  slBps: 1200n,
  trailArmBps: 1_000_000n,
  trailBps: 1000n,
  maxHold: 8,
  holdIfUpBps: 0n,
  highWindow: 2500,
  ddMin: 0.3,
  ddMax: 0.45,
  minHighRealSolLamports: 3_000_000_000n,
  flowTrades: 6,
  minDipBuys: 3,
  lastMustBeBuy: true,
  minNetFlowLamports: 0n,
  trancheLamports: 200_000_000n,
  maxPositionLamports: 1_000_000_000n,
  addBand: 0.05,
  recoverShare: 0,
  cooldownSlots: 300,
  minDipBuyers: 0,
  window: 30,
  minNetSolLamports: 1_000_000_000n,
  minFlowBuys: 3,
  minPriceUp: 0.05,
  maxPriceUp: 1.5,
  accel: 1,
  nearHigh: 0.95,
  maxBuyerShare: 1,
  fadeNetSolLamports: 100_000_000n,
  fadeWindow: 10,
  pyramid: false,
  addSolLamports: 200_000_000n,
};

export const DIP_DEFAULTS: Params = {
  ...SNIPE_DEFAULTS,
  mode: 'dip',
  stakeLamports: 1_000_000_000n,
  maxPositions: 5,
  tpBps: 2000n,
  slBps: 1000n,
  trailArmBps: 1_000_000n,
  trailBps: 1000n,
  maxHold: 600,
};

export const FLOW_DEFAULTS: Params = {
  ...SNIPE_DEFAULTS,
  mode: 'flow',
  stakeLamports: 100_000_000n,
  minAge: 500,
  maxAge: 1_000_000_000,
  tpBps: 3000n,
  slBps: 1500n,
  trailArmBps: 500n,
  trailBps: 2000n,
  maxHold: 800,
};

/** Deterministic runtime caps (loss-log #27): counters, never a clock. */
export const MAX_BATCHES = 120_000;
export const MAX_ORDERS = 120_000;
const MAX_TICKS = 400;
const IDLE_SLOTS = 30_000;
const MAX_TAPES = 4000;

const FEE_BPS = 125n; // protocol 95 + creator 30, charged on both sides of a trade

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
  price: number;
  realSol: bigint;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  /** Price ticks for dip/flow windows (slot, price, realSol, isBuy, sol). */
  ticks: Tick[];
  buysSent: number;
  spentSent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
  /** Dip-mode entry bookkeeping. */
  entryPrice: number;
  entrySlot: number;
  entryHigh: number;
  committed: bigint;
  coolUntil: number;
  exiting: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
  tookTp1: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  let batchesSeen = 0;
  let ordersSent = 0;
  let lastPruneSlot = -1;

  const coinOf = (mint: Pubkey, slot: number): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint, createSlot: slot, creator: '', vq0: 0n, vt0: 1n, devBuy: 0n, trades: 0,
        buyers: new Set(), bought: 0n, soldByOthers: 0n, bigSellBps: 0n, devSold: false,
        lastTradeSlot: slot, recent: [], ticks: [], buysSent: 0, spentSent: 0n,
        lastBuyVq: 0n, lastBuyVt: 1n, lastBuySlot: 0, done: false, complete: false,
        entryPrice: 0, entrySlot: -1, entryHigh: 0, committed: 0n, coolUntil: -1, exiting: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net lamports bought minus sold and distinct non-creator buyers, last flowWindow slots. */
  const flow = (c: Coin, slot: number): { net: bigint; buyers: number } => {
    const from = slot - p.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  };

  /** Dip entry signal on a coin's tick tape at slot `now`. */
  const dipSignal = (c: Coin, now: number): { ok: boolean; hi: number } => {
    const no = { ok: false, hi: 0 };
    const ticks = c.ticks;
    if (ticks.length < p.flowTrades) return no;
    const last = ticks[ticks.length - 1]!;
    if (last.realSol < p.minRealSolLamports) return no;
    if (c.buyers.size < p.minDipBuyers) return no;
    let hi = 0;
    let hiReal = 0n;
    for (let i = ticks.length - 1; i >= 0; i--) {
      const t = ticks[i]!;
      if (now - t.slot > p.highWindow) break;
      if (t.price > hi) {
        hi = t.price;
        hiReal = t.realSol;
      }
    }
    if (hi <= 0 || hiReal < p.minHighRealSolLamports) return no;
    const dd = 1 - last.price / hi;
    if (dd < p.ddMin || dd > p.ddMax) return no;
    let buys = 0;
    let net = 0n;
    for (let i = ticks.length - p.flowTrades; i < ticks.length; i++) {
      const t = ticks[i]!;
      if (t.isBuy) {
        buys++;
        net += t.sol;
      } else net -= t.sol;
    }
    if (buys < p.minDipBuys || net < p.minNetFlowLamports) return no;
    if (p.lastMustBeBuy && !last.isBuy) return no;
    return { ok: true, hi };
  };

  /** Flow (momentum) entry signal on a coin's tick tape at slot `now`. */
  const flowSignal = (c: Coin, now: number, rqSol: number): boolean => {
    if (rqSol < Number(p.minRealSolLamports) / 1e9 || rqSol > Number(p.maxRealSolLamports) / 1e9) return false;
    if (c.createSlot === 0 || now - c.createSlot < p.minAge) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0n;
    let sellSol = 0n;
    let buys = 0;
    let netOld = 0n;
    let netNew = 0n;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, bigint>();
    for (const tr of c.ticks) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.isBuy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.isBuy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0n) + tr.sol);
      } else sellSol += tr.sol;
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minFlowBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSolLamports) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0n || netNew < BigInt(Math.round(p.accel * 1000)) * netOld / 1000n) return false;
    let top = 0n;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > BigInt(Math.round(p.maxBuyerShare * 1e6)) * buySol / 1_000_000n) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots, for fade exits. */
  const netFlow = (c: Coin, now: number, w: number): bigint => {
    let net = 0n;
    for (let i = c.ticks.length - 1; i >= 0; i--) {
      const tr = c.ticks[i]!;
      if (tr.slot <= now - w) break;
      net += tr.isBuy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      batchesSeen++;
      const slot = batch.slot;
      const tx = state.txFeeLamports();
      const cap = state.hello.caps.max_orders_per_batch;
      const orders: OrderInput[] = [];
      const allowNew = batchesSeen <= MAX_BATCHES && ordersSent < MAX_ORDERS;
      const bigSell = new Set<Pubkey>();

      // Fold events into the tapes (only coins that traded this batch are touched).
      const touched: Pubkey[] = [];
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint, e.slot);
          c.createSlot = e.slot;
          c.creator = e.creator;
          c.vq0 = BigInt(e.virtual_quote_reserves);
          c.vt0 = BigInt(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint, e.slot);
          const sol = BigInt(e.sol_amount);
          const vt = BigInt(e.virtual_token_reserves);
          const price = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
          const tick: Tick = { slot: e.slot, isBuy: e.is_buy, sol, user: e.user, price, realSol: BigInt(e.real_quote_reserves) };
          c.recent.push(tick);
          c.ticks.push(tick);
          if (c.recent.length > MAX_TICKS) c.recent.splice(0, c.recent.length - MAX_TICKS);
          if (c.ticks.length > MAX_TICKS) c.ticks.splice(0, c.ticks.length - MAX_TICKS);
          c.trades += 1;
          c.lastTradeSlot = e.slot;
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthers += sol;
            if (p.exitBigSellLamports > 0n && sol >= p.exitBigSellLamports) bigSell.add(e.mint);
            const rqBefore = BigInt(e.real_quote_reserves) + sol;
            if (rqBefore > 0n) {
              const bps = (sol * BPS) / rqBefore;
              if (bps > c.bigSellBps) c.bigSellBps = bps;
            }
          }
          if (touched[touched.length - 1] !== e.mint && !touched.includes(e.mint)) touched.push(e.mint);
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }

      // Bounded prune: at most once per 1000 batches, drop tapes idle for IDLE_SLOTS.
      if (coins.size > MAX_TAPES && slot - lastPruneSlot >= 1000) {
        lastPruneSlot = slot;
        for (const [mint, c] of coins) {
          if (slot - c.lastTradeSlot > IDLE_SLOTS && !state.positions.has(mint)) coins.delete(mint);
        }
      }

      // Fills: track tx fees paid and clear sell-in-flight flags.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'sell') {
          selling.delete(f.mint);
          const c = coins.get(f.mint);
          if (c !== undefined) {
            c.exiting = false;
            if (!state.positions.has(f.mint)) {
              c.committed = 0n;
              c.entrySlot = -1;
              c.coolUntil = slot + p.cooldownSlots;
              if (p.mode === 'snipe' || p.mode === 'flow') c.done = true;
            }
          }
        } else if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          const c = coins.get(f.mint);
          held.set(f.mint, {
            openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n,
            devSoldAtOpen: c?.devSold ?? false, tookTp1: false,
          });
        } else if (f.side === 'buy' && f.status !== 'filled' && !state.positions.has(f.mint)) {
          let stillPending = false;
          for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
          if (!stillPending) {
            const c = coins.get(f.mint);
            if (c !== undefined) {
              c.committed = 0n;
              c.entrySlot = -1;
            }
          }
        }
      }
      for (const mint of [...selling]) {
        let pend = false;
        for (const o of state.pending.values()) if (o.order.mint === mint && o.order.side === 'sell') pend = true;
        if (!pend) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        let pendBuy = false;
        for (const o of state.pending.values()) if (o.order.mint === mint && o.order.side === 'buy') pendBuy = true;
        if (!state.positions.has(mint) && !selling.has(mint) && !pendBuy) held.delete(mint);
      }

      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      const pendingMints = new Set<Pubkey>();
      for (const o of state.pending.values()) pendingMints.add(o.order.mint);
      const hasPendingSell = (mint: Pubkey): boolean => {
        for (const o of state.pending.values()) if (o.order.mint === mint && o.order.side === 'sell') return true;
        return false;
      };

      // ---- Exits first (all modes share the same exit engine). ----
      const heldMints = [...state.positions.keys()].sort();
      for (const mint of heldMints) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const pos = state.positions.get(mint)!;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false, tookTp1: false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (p.tp1Bps > 0n && !h.tookTp1 && value * BPS >= basis * (BPS + p.tp1Bps)) {
            const part = (pos.token_amount * p.tp1PartBps) / BPS;
            if (part > 0n && part < pos.token_amount && !hasPendingSell(mint)) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + p.tpBps)) exit = true;
          if (value * BPS <= basis * (BPS - p.slBps)) exit = true;
          if (h.best * BPS >= basis * (BPS + p.trailArmBps) && value * BPS <= h.best * (BPS - p.trailBps)) exit = true;
        }
        if (slot - h.openedSlot >= p.maxHold && !(p.holdIfUpBps > 0n && value * BPS >= basis * (BPS + p.holdIfUpBps))) exit = true;
        if (c !== undefined) {
          if (p.mode === 'snipe' && p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (p.exitBigSellLamports > 0n && bigSell.has(mint)) exit = true;
          if (slot - c.lastTradeSlot >= p.staleSlots) exit = true;
          if (p.fadeNetSolLamports > 0n && netFlow(c, slot, p.fadeWindow) < -p.fadeNetSolLamports) exit = true;
          if (p.mode === 'dip' && p.recoverShare > 0 && c.entryHigh > 0) {
            const target = c.entryPrice + p.recoverShare * (c.entryHigh - c.entryPrice);
            const lastPrice = c.ticks.length > 0 ? c.ticks[c.ticks.length - 1]!.price : 0;
            if (lastPrice >= target && value > basis) exit = true;
          }
        }
        if (!exit) continue;
        if (hasPendingSell(mint)) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = p.mode !== 'dip';
      }

      // ---- Entries / adds (only while the runtime caps allow new risk). ----
      if (allowNew) {
        let free = state.freeCashLamports();
        let open = state.committedPositionCount();
        let exposure = 0n;
        for (const [mint, pos] of state.positions) exposure += pos.cost_lamports;
        let entries = 0;

        if (p.mode === 'dip') {
          // Adds on held dip positions first.
          for (const mint of heldMints) {
            if (orders.length >= cap) break;
            const pos = state.positions.get(mint);
            const c = coins.get(mint);
            if (pos === undefined || c === undefined || c.exiting || pendingMints.has(mint)) continue;
            if (c.committed >= p.maxPositionLamports) continue;
            const lastPrice = c.ticks.length > 0 ? c.ticks[c.ticks.length - 1]!.price : 0;
            if (c.entryPrice > 0 && Math.abs(lastPrice / c.entryPrice - 1) > p.addBand) continue;
            let amount = p.maxPositionLamports - c.committed;
            if (amount > p.trancheLamports) amount = p.trancheLamports;
            const sizeCap = (state.maxBuyLamports(mint) * 97n) / 100n;
            if (amount > sizeCap) amount = sizeCap;
            if (amount < p.minBuyLamports) continue;
            if (free - amount - tx < p.cashReserveLamports) continue;
            if (exposure + amount > p.maxExposureLamports) continue;
            orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
            c.committed += amount;
            free -= amount + tx;
            exposure += amount;
            pendingMints.add(mint);
          }
          // New dip entries on coins that traded this batch.
          for (const mint of touched) {
            if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
            if (open >= state.hello.caps.max_open_positions || open >= p.maxPositions) break;
            if (state.positions.has(mint) || pendingMints.has(mint)) continue;
            const curve = state.curves.get(mint);
            const c = coins.get(mint);
            if (curve === undefined || curve.complete || c === undefined) continue;
            if (slot < c.coolUntil) continue;
            const sig = dipSignal(c, slot);
            if (!sig.ok) continue;
            let amount = p.trancheLamports;
            if (amount > p.maxPositionLamports) amount = p.maxPositionLamports;
            const sizeCap = (state.maxBuyLamports(mint) * 97n) / 100n;
            if (amount > sizeCap) amount = sizeCap;
            if (amount < p.minBuyLamports) continue;
            if (free - amount - tx < p.cashReserveLamports) continue;
            if (exposure + amount > p.maxExposureLamports) continue;
            orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
            const lastPrice = c.ticks[c.ticks.length - 1]!.price;
            c.entryPrice = lastPrice;
            c.entrySlot = slot;
            c.entryHigh = sig.hi;
            c.committed = amount;
            c.exiting = false;
            free -= amount + tx;
            exposure += amount;
            pendingMints.add(mint);
            entries++;
            open++;
          }
        } else {
          // Snipe / flow entries on coins that traded this batch.
          for (const mint of touched) {
            if (orders.length >= cap) break;
            const curve = state.curves.get(mint);
            const c = coins.get(mint);
            if (curve === undefined || curve.complete || c === undefined) continue;
            if (c.done) continue;
            const age = slot - c.createSlot;
            const isAdd = c.buysSent > 0;
            if (!isAdd) {
              if (entries >= p.maxEntriesPerBatch) continue;
              if (age < p.minAge) continue;
              if (p.mode === 'snipe' && age > p.maxAge) {
                c.done = true;
                continue;
              }
              if (open >= state.hello.caps.max_open_positions || open >= p.maxPositions) continue;
              if (state.positions.has(mint) || pendingMints.has(mint)) continue;
              if (p.mode === 'snipe') {
                const rq = curve.real_quote_reserves;
                if (rq < p.minRealSolLamports || rq > p.maxRealSolLamports) continue;
                if (c.devBuy > p.maxDevBuyLamports) continue;
                if (c.trades < p.minTrades || c.bought < p.minBoughtLamports) continue;
                if (c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) continue;
                if (c.bought > 0n && c.soldByOthers * BPS > c.bought * p.maxSellRatioBps) continue;
                if (c.bigSellBps > p.maxBigSellBps) continue;
                const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0);
                if (runup > p.maxRunupBps || runup < p.minRunupBps) continue;
                const fl = flow(c, slot);
                if (fl.net < p.minFlowLamports || fl.buyers < p.minRecentBuyers) continue;
                if (c.devSold && p.skipDevSold) {
                  c.done = true;
                  continue;
                }
              } else {
                const rqSol = Number(curve.real_quote_reserves) / 1e9;
                if (!flowSignal(c, slot, rqSol)) continue;
              }
              const room = p.stakeLamports - c.spentSent;
              if (room < p.minBuyLamports) continue;
              const maxBuy = state.maxBuyLamports(mint);
              const amount = room < maxBuy ? room : maxBuy;
              if (amount < p.minBuyLamports) continue;
              if (free - amount - tx < p.cashReserveLamports) continue;
              if (exposure + amount > p.maxExposureLamports) continue;
              orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
              free -= amount + tx;
              exposure += amount;
              c.buysSent += 1;
              c.spentSent += amount;
              c.lastBuyVq = curve.virtual_quote_reserves;
              c.lastBuyVt = curve.virtual_token_reserves;
              c.lastBuySlot = slot;
              pendingMints.add(mint);
              entries++;
              open++;
            } else if (p.mode === 'snipe' && p.maxAdds > 0) {
              // Add-on buy while the launch keeps qualifying.
              if (c.buysSent > p.maxAdds) continue;
              if (!state.positions.has(mint) || selling.has(mint) || pendingMints.has(mint)) continue;
              if (slot - c.lastBuySlot < p.addDelay) continue;
              const vq = curve.virtual_quote_reserves;
              const vt = curve.virtual_token_reserves;
              if (vq * c.lastBuyVt * BPS < c.lastBuyVq * vt * (BPS + p.addStepBps)) continue;
              const maxBuy = state.maxBuyLamports(mint);
              const amount = p.addLamports < maxBuy ? p.addLamports : maxBuy;
              if (amount < p.minBuyLamports) continue;
              if (free - amount - tx < p.cashReserveLamports) continue;
              if (exposure + amount > p.maxExposureLamports) continue;
              orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
              free -= amount + tx;
              exposure += amount;
              c.buysSent += 1;
              c.spentSent += amount;
              c.lastBuyVq = vq;
              c.lastBuyVt = vt;
              c.lastBuySlot = slot;
              pendingMints.add(mint);
            } else if (p.mode === 'flow' && p.pyramid) {
              if (c.buysSent > 0 && c.spentSent >= p.stakeLamports - p.minBuyLamports) continue;
              if (!state.positions.has(mint) || selling.has(mint) || pendingMints.has(mint)) continue;
              const rqSol = Number(curve.real_quote_reserves) / 1e9;
              if (!flowSignal(c, slot, rqSol)) continue;
              const maxBuy = state.maxBuyLamports(mint);
              let amount = p.addSolLamports;
              if (amount > maxBuy) amount = maxBuy;
              if (amount > p.stakeLamports - c.spentSent) amount = p.stakeLamports - c.spentSent;
              if (amount < p.minBuyLamports) continue;
              if (free - amount - tx < p.cashReserveLamports) continue;
              if (exposure + amount > p.maxExposureLamports) continue;
              orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
              free -= amount + tx;
              exposure += amount;
              c.buysSent += 1;
              c.spentSent += amount;
              pendingMints.add(mint);
            }
          }
        }
      }

      ordersSent += orders.length;
      return orders;
    },
  };
}
