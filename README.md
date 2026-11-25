# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-chapo124574

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Chapo1245/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-chapo124574/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Chapo1245/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-chapo124574/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for the pump.fun bonding-curve replay (agent-fun/replay/v2). It buys fresh launches 1–2 slots after creation, only when the launch looks real (up to 7 distinct early buyers, creator buy ≤ 5 SOL), sizes 0.1 SOL per coin, and exits fast: half the position at +5%, the rest at +15% or −12%, a 2 SOL single-sell dump exit, or an 8-slot time limit. Buys use a 15% slippage cap so the 2-slot latency never chases a runaway price, and buys are at least 0.05 SOL so tx fees never eat a tiny position. The bot is deterministic (no clock, no randomness) and bounds its own work with batch/order counters and capped per-coin tapes, so a full replay finishes in seconds, far inside the 1800 s wall budget.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout: it reads `hello`, then one `batch` per slot, and writes one `reply` per batch. Node 22+ required, standard library only (the SDK shim is vendored in `vendor/`).

## Strategy

- **Entry (snipe):** age 1–2 slots after the CreateEvent; real SOL 0.3–30; creator's own create-slot buy ≤ 5 SOL; ≤ 7 distinct non-creator buyers; no creator sale yet; buy 0.1 SOL (capped at 1% of real reserves, min 0.05 SOL), 15% buy slippage.
- **Exits:** sell 50% at +5% over cost; sell all at +15% or −12%; exit at once on a single sell ≥ 2 SOL or a creator sale; exit if net flow over 10 slots falls below −0.1 SOL; hard 8-slot hold limit.
- **Risk:** max 5 open positions, 6 SOL max exposure, 1 SOL cash reserve kept at all times. A round trip must be ≥ 0.05 SOL, so every trade clears the 0.01 SOL guardrail floor with room to spare.

## Local self-grade (kit replay sim, all three dataset parts)

| variant | net PnL (SOL) | trades | win rate | max DD |
| --- | --- | --- | --- | --- |
| snipe (this entry) | **+0.247** [+0.117 / +0.207 / −0.076] | 147 | 41% | 1.4% |
| snipe, looser slippage | +0.102 | 116 | 38% | 1.5% |
| hot-hold (buy hot launches, trail) | −0.522 | 196 | 34% | 3.6% |
| dip-buy (all coins) | −3.214 (part 0) | 138 | 19% | 36% |
| dip-buy on hot coins only | −0.678 | 180 | 38% | 13% |
| flow / mature momentum | +0.011 (only 9 coins — fails the 20-coin guardrail) | 9 | 44% | 0.8% |
| pilot momentum baseline | −9.384 (part 0) | 80 | 6% | 95% |
| pilot reversion baseline | −1.779 (part 0) | 170 | 26% | 18% |
| pilot sniper baseline | −0.138 (part 0) | 135 | — | 1.7% |

Net PnL is after all fees (95 bps protocol + 30 bps creator + 105k lamports per order). At 2x fees the entry is −0.141 SOL total; the ranking uses normal fees. Runtime: ~2 s per dataset part locally; the full stdin/stdout replay of 25,804 batches completes in 1.9 s with 25,804/25,804 valid replies.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wtacm6ft&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
