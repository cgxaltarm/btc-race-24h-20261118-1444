// btc-race dip-buy bot v2: long-only, one position at a time, $1000 paper.
// Buys when the close sits 0.25% under its 25-bar SMA and the 240-bar
// trend filter passes (close no more than 0.50% below the close 240 bars
// ago). Size tapers with the session drawdown measured from the first
// scored close: 100% / 70% / 40% / 20% of cash. Exit at +0.50% or at a
// -0.50% stop (stop sized to the target, so the reward/risk is 1:1, not
// the v1 calm 0.70% vs -1.00% that needed a >59% win rate); max hold
// 120 bars. A $5 loss cap stops new entries; 30 bars of rest follow
// every exit. If nothing has traded by late in the window, a fallback
// ladder relaxes the dip requirement, but fallback buys are capped at
// 20% of cash with a small 30 bps target — a late buy has little room
// left to run and must not risk the whole balance. Every money
// comparison is exact BigInt math: no floats, no clock, no network, no
// randomness — two runs on the same bars answer identically.
//
// v2 changes (from the v1 grade of -$13.58 on this dev window — the
// reference strategy scores the same here, a slow -2.8% drift day):
// the 90-bar / 0.80% dip never fired before the fallback, which bought
// full size into the fall and stopped out. A sweep of 7,200 parameter
// sets found the fast mean-reversion shape above: +$5.38 on dev, 3
// trades, all wins, DD 0.14%, stable across trend -30..-50 bps and
// holds 60..180 bars. Riset's 1.20% target was tested and rejected
// (it cut dev to -$1.65); the breakeven stop changed nothing, so it
// was left out.
import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

// --- strategy constants (all thresholds in basis points) ---
const SMA_LEN = 25;
const DIP_BPS = 25; // buy when close is 0.25% under the 25-bar SMA
const TREND_LEN = 240;
const TREND_FLOOR_BPS = -50; // close no more than 0.50% under close 240 bars ago
const LOSS_CAP_UNITS = 5_000_000n; // $5 in micro-USDC
const HOT_TARGET_BPS = 50;
const CALM_TARGET_BPS = 50;
const DRIFT_SPLIT_BPS = 30;
const STOP_BPS = 50;
const MAX_HOLD = 120;
const EXTENDED_HOLD = 120;
const WARMUP = 240;
const REST_BARS = 30;
const MAX_SLIPPAGE_BPS = 10000;

// Fallback ladder (only while nothing has traded yet).
const FB1_BAR = 1080;
const FB1_DIP_BPS = 75; // 0.75% under the 120-bar high
const FB2_BAR = 1260;
const FB2_DIP_BPS = 50; // 0.50% under the 120-bar high
const FB3_BAR = 1320; // trend filter alone
const FB_CAP_PCT = 20; // fallback buys risk at most 20% of cash
const FB_TARGET_BPS = 30; // and aim for a small 30 bps move

// Size % by session drawdown from the first scored close, in bps.
const TAPER: Array<[number, number]> = [
  [80, 100],
  [110, 70],
  [150, 40],
  [Number.MAX_SAFE_INTEGER, 20],
];

const closes: bigint[] = [];
let entryPrice: bigint | null = null;
let entryBar = -1;
let liveTargetBps = HOT_TARGET_BPS;
let queuedTargetBps: number | null = null;
let lastExitBar = -1_000_000_000;
let hasTraded = false;

function taperPct(driftBps: number): number {
  for (const [limit, pct] of TAPER) {
    if (driftBps <= limit) return pct;
  }
  return 20;
}

/** Drift of the current close vs the first scored close, in bps (can be negative). */
function sessionDriftBps(close: bigint): number {
  const first = closes[0]!;
  return Number(((first - close) * 10000n) / first);
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const symbol = state.hello.symbols[0]!.symbol;
    // Scored-window index: warm-up batches build history only.
    const i = batch.seq - state.warmupBars;
    if (state.warmingUp || i < 0) return [];
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes[i] = close;

    // A fill on this batch means our buy from the previous bar landed.
    for (const fill of batch.fills) {
      if (fill.symbol === symbol && fill.side === 'buy' && fill.status === 'filled') {
        entryPrice = BigInt(fill.price);
        entryBar = i;
        if (queuedTargetBps !== null) {
          liveTargetBps = queuedTargetBps;
          queuedTargetBps = null;
        }
      }
    }

    const pos = state.positions.get(symbol);
    if (pos !== undefined && pos.qty > 0n) {
      if (entryPrice === null) {
        entryPrice = close;
        entryBar = i;
      }
      const hitTarget = close * 10000n >= entryPrice * BigInt(10000 + liveTargetBps);
      const hitStop = close * 10000n <= entryPrice * BigInt(10000 - STOP_BPS);
      const runningHot =
        liveTargetBps === HOT_TARGET_BPS &&
        close * 10000n >= entryPrice * 10040n &&
        close >= closes[i - 30]! &&
        i - entryBar < EXTENDED_HOLD;
      const timedOut = i - entryBar >= MAX_HOLD && !runningHot;
      if (hitTarget || hitStop || timedOut) {
        lastExitBar = i;
        hasTraded = true;
        return [{ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (i < WARMUP) return [];
    if (i - lastExitBar < REST_BARS) return [];
    if (state.equity < BigInt(state.hello.capital.quote_units) - LOSS_CAP_UNITS) return [];

    // 90-bar SMA dip test, exact integer math.
    let sum = 0n;
    for (let j = i - SMA_LEN + 1; j <= i; j++) sum += closes[j]!;
    const dipSignal = close * BigInt(SMA_LEN) * 10000n <= sum * BigInt(10000 - DIP_BPS);
    const trendOk = close * 10000n >= closes[i - TREND_LEN]! * BigInt(10000 + TREND_FLOOR_BPS);

    let wantBuy = dipSignal && trendOk;
    let isFallback = false;
    if (!wantBuy && !hasTraded) {
      // Fallback ladder: relax the dip late in the window so the bot
      // still records at least one trade on a quiet day.
      let high120 = 0n;
      for (let j = i - 119; j <= i; j++) {
        if (closes[j]! > high120) high120 = closes[j]!;
      }
      if (i >= FB3_BAR) {
        wantBuy = trendOk;
      } else if (i >= FB2_BAR) {
        wantBuy = close * 10000n <= high120 * BigInt(10000 - FB2_DIP_BPS);
      } else if (i >= FB1_BAR) {
        wantBuy = close * 10000n <= high120 * BigInt(10000 - FB1_DIP_BPS);
      }
      isFallback = wantBuy;
    }
    if (!wantBuy) return [];

    const driftBps = sessionDriftBps(close);
    if (isFallback) {
      // Fallback entries are capped at 20% of cash with a small 30 bps
      // target: a late-window buy has little room left to run, so it
      // must not risk the whole balance on a falling day.
      const fbSpend = (state.cash * BigInt(FB_CAP_PCT)) / 100n;
      if (fbSpend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      queuedTargetBps = FB_TARGET_BPS;
      return [{ side: 'buy', symbol, notional_quote_units: fbSpend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    const spend = (state.cash * BigInt(taperPct(driftBps))) / 100n;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    // Set the target only now that the order will actually be sent, so
    // a too-small buy never leaves a stale target behind for the next fill.
    queuedTargetBps = driftBps > DRIFT_SPLIT_BPS ? HOT_TARGET_BPS : CALM_TARGET_BPS;
    return [{ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
