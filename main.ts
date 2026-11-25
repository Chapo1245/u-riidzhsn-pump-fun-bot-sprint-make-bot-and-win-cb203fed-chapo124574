// Pump.fun replay bot — entrypoint for agent-fun/replay/v2.
// The grader runs `node main.ts`; the strategy lives in strategy.ts and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// Shipped strategy: launch sniper — buy 1-2 slots after creation (<=7 early
// buyers, creator buy <= 5 SOL), 0.1 SOL per coin, half out at +5%, all out at
// +15% / -12% / big-sell / 8-slot limit. See strategy.ts SNIPE_DEFAULTS.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, SNIPE_DEFAULTS } from './strategy.ts';

await runBot(createStrategy(SNIPE_DEFAULTS));
