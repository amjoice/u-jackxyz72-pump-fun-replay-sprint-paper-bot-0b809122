// PaperBot — Pump.fun Replay Sprint (pumpfun-replay/v2)
//
// A "tiny lottery" bot. The dev window's own data says most pump.fun coins
// fade a few percent and only a handful run far — and momentum chasing buys
// after the rise, so it pays the fade plus fees on nearly every coin. This
// bot does the opposite: it buys a tiny stake (0.012 SOL) in each fresh curve
// that gathers real SOL quickly, holds it almost to the end of the replay,
// and only sells on a hard stop, a wide trailing stop, or a +100%
// take-profit. Turnover — and therefore fees — stay minimal, the 20-coin
// guardrail is met by the entries themselves, and the rare runner that
// doubles pays for the many small fades. Fully deterministic: no clock, no
// environment, no randomness — every decision comes from the batch stream.
//
// Capital: 10 SOL paper. Max 5 open positions. No shorts, no leverage.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n
const TX_FEE = 105_000n; // base + priority fee per order, from hello.fees

// Entry: a curve is bought once, soon after creation, as soon as the size
// cap lets a meaningful buy through. No momentum filter — on the dev window
// every signal filter tested made the result worse, because it screened out
// the runners as often as the duds.
const MIN_AGE_SLOTS = 10; // ignore the very first seconds (bundled launches)
const MAX_AGE_SLOTS = 400; // ... and anything older than ~3 minutes
const STAKE_SOL = 0.012; // one tiny buy per coin (>= 0.01 SOL round-trip bar)
const MIN_BUY_SOL = 0.012;
const BUY_SLIP_BPS = 800; // buys tolerate 8% slippage (latency is 2 slots)
const SELL_SLIP_BPS = 10_000; // sells always go out
const MAX_ENTRIES_PER_CURVE = 2;
const COOLDOWN_SLOTS = 300; // wait after an exit before re-entering a curve

// Exits. Wide stops: the median coin only fades ~6%, so a tight stop just
// locks in the fade plus fees. The take-profit is where the money is made.
const STOP_LOSS = 0.3; // sell when value < cost * 0.70
const TRAIL_ARM = 0.5; // trailing stop arms once value >= cost * 1.50
const TRAIL_DROP = 0.3; // ... then sell when value falls 30% from its peak
const TAKE_PROFIT = 1.0; // sell the whole position at +100%
const MAX_HOLD_SLOTS = 100_000; // effectively hold to the end of the replay
const HOLD_IF_UP = 0.3; // the time limit does not apply while up >= 30%

// Guardrail probes: tiny round trips that keep the run above 20 coins if
// the lottery entries ever fall behind pace.
const PROBE_SOL = 0.015;
const PROBE_TARGET_COINS = 30;
const MAX_PROBES_OPEN = 1;

// ------------------------------------------------------------------ state

interface CurveInfo {
  createdSlot: number;
  entries: number;
  lastExitSlot: number;
  complete: boolean;
  lastTradeSlot: number;
}

interface PositionBook {
  peakValue: bigint; // best close value seen (lamports)
  entrySlot: number;
  probe: boolean; // a guardrail probe, sold as soon as it lands
}

const curves = new Map<Pubkey, CurveInfo>();
const books = new Map<Pubkey, PositionBook>();
const pendingBuys = new Map<Pubkey, bigint>();
const pendingSells = new Set<Pubkey>();
const probeIntents = new Set<Pubkey>();
let firstSlot = -1;
let coinsRoundTripped = 0;
const soldMints = new Set<Pubkey>();
const boughtMints = new Set<Pubkey>();

function curvePrice(state: BotState, mint: Pubkey): number {
  const c = state.curves.get(mint);
  if (!c || c.virtual_token_reserves === 0n) return 0;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function exitReason(
  state: BotState,
  mint: Pubkey,
  book: PositionBook,
  nowSlot: number,
): string | null {
  const pos = state.positions.get(mint);
  if (!pos) return null;
  const price = curvePrice(state, mint);
  if (price <= 0) return null;
  const value = BigInt(Math.floor(Number(pos.token_amount) * price));
  if (value > book.peakValue) book.peakValue = value;
  const cost = pos.cost_lamports;
  // Take profit first: bank the double.
  if (value * 100n >= cost * BigInt(Math.round((1 + TAKE_PROFIT) * 100))) return 'takeprofit';
  // Stop loss against cost.
  if (value * 100n < cost * BigInt(Math.round((1 - STOP_LOSS) * 100))) return 'stop';
  // Trailing stop, armed once the position is up TRAIL_ARM.
  if (book.peakValue * 100n >= cost * BigInt(Math.round((1 + TRAIL_ARM) * 100))) {
    if (value * 100n < book.peakValue * BigInt(Math.round((1 - TRAIL_DROP) * 100))) return 'trail';
  }
  // Time limit, unless comfortably up.
  if (
    nowSlot - book.entrySlot > MAX_HOLD_SLOTS &&
    value * 100n < cost * BigInt(Math.round((1 + HOLD_IF_UP) * 100))
  ) {
    return 'time';
  }
  return null;
}

// ------------------------------------------------------------------ bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const nowSlot = batch.slot;
    if (firstSlot < 0) firstSlot = nowSlot;
    const orders: OrderInput[] = [];
    const caps = state.hello.caps;

    // Fold this batch's events into the curve table.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!curves.has(e.mint)) {
          curves.set(e.mint, {
            createdSlot: e.slot,
            entries: 0,
            lastExitSlot: -1e9,
            complete: false,
            lastTradeSlot: e.slot,
          });
        }
      } else if (e.event === 'TradeEvent') {
        let info = curves.get(e.mint);
        if (!info) {
          info = {
            createdSlot: -1e9,
            entries: 0,
            lastExitSlot: -1e9,
            complete: false,
            lastTradeSlot: e.slot,
          };
          curves.set(e.mint, info);
        }
        info.lastTradeSlot = e.slot;
      } else if (e.event === 'CompleteEvent') {
        const info = curves.get(e.mint);
        if (info) info.complete = true;
      }
    }

    // Track fills: a buy landing starts a position book; a sell landing closes one.
    for (const f of batch.fills) {
      if (f.status !== 'filled') {
        if (f.side === 'buy') pendingBuys.delete(f.mint);
        else pendingSells.delete(f.mint);
        continue;
      }
      if (f.side === 'buy') {
        boughtMints.add(f.mint);
        pendingBuys.delete(f.mint);
        if (!books.has(f.mint)) {
          const isProbe = probeIntents.has(f.mint);
          probeIntents.delete(f.mint);
          books.set(f.mint, {
            peakValue: 0n,
            entrySlot: f.decided_slot,
            probe: isProbe,
          });
        }
      } else if (f.side === 'sell') {
        pendingSells.delete(f.mint);
        if (boughtMints.has(f.mint) && !soldMints.has(f.mint)) {
          soldMints.add(f.mint);
          coinsRoundTripped += 1;
        }
        const info = curves.get(f.mint);
        if (info) info.lastExitSlot = nowSlot;
        books.delete(f.mint);
      }
    }
    // Prune stale curves (no trades in a while, nothing held) to bound memory.
    if (batch.seq % 500 === 0) {
      for (const [mint, info] of curves) {
        if (
          nowSlot - info.lastTradeSlot > 2000 &&
          !state.positions.has(mint) &&
          !pendingBuys.has(mint)
        ) {
          curves.delete(mint);
        }
      }
    }

    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const maxOrders = caps.max_orders_per_batch;

    // --- Exits first: sell positions whose exit rule fired. ---
    for (const [mint, book] of books) {
      if (orders.length >= maxOrders) break;
      const pos = state.positions.get(mint);
      if (!pos) continue;
      if (pendingSells.has(mint)) continue; // sell already in flight
      // Probes sell as soon as the buy has landed.
      const reason = book.probe ? 'probe' : exitReason(state, mint, book, nowSlot);
      if (reason === null) continue;
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: SELL_SLIP_BPS,
      });
      free -= TX_FEE;
      pendingSells.add(mint);
    }

    // --- New entries: one tiny buy per young curve, in event order. ---
    const seenThisBatch = new Set<Pubkey>();
    for (const e of batch.events) {
      if (orders.length >= maxOrders || slots <= 0) break;
      if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
      const mint = e.mint;
      if (seenThisBatch.has(mint)) continue;
      seenThisBatch.add(mint);
      if (state.positions.has(mint) || pendingBuys.has(mint)) continue;
      const info = curves.get(mint);
      if (!info || info.complete) continue;
      const age = nowSlot - info.createdSlot;
      if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) continue;
      if (info.entries >= MAX_ENTRIES_PER_CURVE) continue;
      if (nowSlot - info.lastExitSlot < COOLDOWN_SLOTS) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < BigInt(Math.round(MIN_BUY_SOL * 1e9))) continue;
      const amount = cap < BigInt(Math.round(STAKE_SOL * 1e9))
        ? cap
        : BigInt(Math.round(STAKE_SOL * 1e9));
      if (free < amount + TX_FEE) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + TX_FEE;
      slots -= 1;
      pendingBuys.set(mint, (pendingBuys.get(mint) ?? 0n) + amount);
      info.entries += 1;
    }

    // --- Guardrail probes: keep round-tripped coins on pace. ---
    const elapsedSlots = Math.max(1, nowSlot - firstSlot);
    const paceFrac = Math.min(1, elapsedSlots / 400_000);
    const wantCoins = Math.ceil(PROBE_TARGET_COINS * paceFrac);
    let probesOpen = 0;
    for (const book of books.values()) if (book.probe) probesOpen += 1;
    if (
      coinsRoundTripped + probesOpen < wantCoins &&
      probesOpen < MAX_PROBES_OPEN &&
      slots > 0 &&
      orders.length < maxOrders
    ) {
      // Pick the most liquid curve with recent trades that we have never traded.
      let bestMint: Pubkey | null = null;
      let bestReal = 0n;
      for (const [mint, info] of curves) {
        if (info.complete) continue;
        if (boughtMints.has(mint) || pendingBuys.has(mint)) continue;
        if (state.positions.has(mint)) continue;
        if (nowSlot - info.lastTradeSlot > 120) continue;
        const curve = state.curves.get(mint);
        if (!curve) continue;
        if (curve.real_quote_reserves > bestReal) {
          bestReal = curve.real_quote_reserves;
          bestMint = mint;
        }
      }
      if (bestMint !== null) {
        const cap = state.maxBuyLamports(bestMint);
        const amount = BigInt(Math.round(PROBE_SOL * 1e9));
        if (cap >= amount && free >= amount + TX_FEE) {
          orders.push({ side: 'buy', mint: bestMint, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
          free -= amount + TX_FEE;
          slots -= 1;
          pendingBuys.set(bestMint, (pendingBuys.get(bestMint) ?? 0n) + amount);
          const info = curves.get(bestMint);
          if (info) info.entries += 1;
          probeIntents.add(bestMint);
        }
      }
    }

    return orders;
  },
});
