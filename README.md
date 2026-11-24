# PaperBot — Pump.fun Replay Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/amjoice/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/amjoice/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A trading bot that trades 10 SOL of paper money on a replay of recorded
pump.fun activity, entered in the
[Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
bounty on make.fun. Nothing is traded for real.

## Strategy: tiny lottery

The dev window's own data says most pump.fun coins fade a few percent and
only a handful run far — and momentum chasing buys after the rise, so it pays
the fade plus fees on nearly every coin. This bot does the opposite:

- Buys a tiny stake (**0.012 SOL**) in each fresh curve that gathers real SOL
  quickly (age 10–400 slots, as soon as the 1%-of-reserve size cap allows).
- Holds it almost to the end of the replay — no momentum filter, no pyramid,
  no frequent trading, so turnover and fees stay minimal.
- Sells only on a hard stop (-30% vs cost), a wide trailing stop (arms at
  +50%, sells on a 30% fall from peak), or a **+100% take-profit**.
- Small probe round-trips keep the run above the 20-coin guardrail if the
  lottery entries ever fall behind pace.

Local dev-window grade (kit's `grade-local`, process driver): **-0.036 SOL**
net PnL, 97 fills, 51 coins, max drawdown 0.79% — near breakeven, and better
than the kit's own momentum pilot (-9.49 SOL) and sniper pilot (-0.47 SOL)
on the same window. The final window is different data; the bot is built to
lose little when nothing runs and to bank the rare coin that doubles.

## Layout

- `main.ts` — the entrypoint, run by the grader as `node /bot/main.ts`
  (Node 22 strips the types; no build, no install, no network at run time).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` bot shim,
  vendored byte-identical from the competition kit.

## Determinism

No clock, no environment, no randomness. Every decision comes from the
harness batch stream only, so the two grading executions produce identical
action logs.

## License

MIT — see [LICENSE](LICENSE).
