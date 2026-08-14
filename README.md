![dsh-token-stats](assets/banner.png)

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="#"><img alt="Zero build" src="https://img.shields.io/badge/build-zero--step-success.svg"></a>
  <a href="#"><img alt="Harness" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20(web)-8b5cf6.svg"></a>
  <a href="https://github.com/Ouye-UE/dsh-token-stats/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/Ouye-UE/dsh-token-stats?style=social"></a>
</p>

# dsh-token-stats

A **permanent sidebar plugin** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that shows a live token-usage panel at the bottom of the left sidebar (`sidebar.footer.action`).

Deploy once — it auto-loads on every DSH start. No approvals, no build step.

## Panel

```
Tokens    80.0M                ← live, compact K/M
缓存命中  62%
费用      ¥3.97                ← hover: per-bucket breakdown
系统调用  3.5K · ¥0.01          ← only when non-zero
余额      ¥88.50               ← hover: topped-up / granted split
上下文    [████████░░]  62%    ← green/yellow/red by usage
─────────────────────────────
[Cordis plugins]
[Settings]
```

## Features

| Row | Answers | Data source |
| --- | --- | --- |
| **Tokens** | How many tokens has this session consumed? | `tokenUsage` projection (live, per session) |
| **缓存命中** | How much did the context cache save? | cache-read share of billed input |
| **费用** | What did this session roughly cost? | per-request fold — each request priced by its own model × Beijing-time price period |
| **系统调用** | Hidden LLM calls (titles, compaction) | `llm/stream` interceptor |
| **余额** | How much money is left on the account? | official `GET /user/balance`, server-side API key |
| **上下文** | How full is the context window? | `contextPressure` projection |

Highlights:

- **Accurate mixed pricing** — usage is folded per `model × price period`. Flash tokens are priced at flash rates, pro tokens at pro rates, and each request is classified by its own timestamp (`current` price before the peak/off-peak scheme, `peak` 9–12/14–18 Beijing time, `offPeak` otherwise). Hover the 费用 row for the per-bucket breakdown.
- **Real account balance** — queried from DeepSeek's official balance endpoint with the deployment's `DEEPSEEK_API_KEY`; the key never reaches the browser.
- **No drift from the native stats** — Tokens / cache-hit / context figures come from Harness's own projections (the same source as the shipped stats line).

## How it works

Dual-face package, zero external npm dependencies (it consumes only Harness host services):

```
lib/index.js   Host half      GET /token-stats/stats?sessionId=<id>
                · balance with 30s cache (official /user/balance)
                · per-model×period usage fold from the session event log
                · llm/stream interceptor for hidden system calls

lib/client.js  Browser half   sidebar.footer.action panel
                · projections via useSessions → projectionValues (live)
                · polls the stats route every 2s
```

## Install

1. Copy this package into the web profile's `node_modules`:

   ```powershell
   # e.g. <DSH_HOME> = C:\Users\you\.dsh
   Copy-Item .\dsh-token-stats "<DSH_HOME>\profiles\node_modules\dsh-token-stats" -Recurse
   ```

2. Add one row to `<DSH_HOME>/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: token-stats
         name: dsh-token-stats
   ```

   (See `examples/cordis.patch.yml`.)

3. Restart DSH (`dsh web`). Done — the panel loads automatically from now on.

## Configuration

Edit `lib/client.js`:

```js
const CONFIG = {
  model: 'deepseek-v4-flash',   // fallback price table for unknown model ids
  newPricingFrom: '2026-08-17', // Beijing-time date the peak/off-peak scheme starts
};

const PRICES = {
  'deepseek-v4-flash': {
    current: { hit: 0.02, miss: 1,    out: 2   },
    offPeak: { hit: 0.05, miss: 1.5,  out: 4.5 },
    peak:    { hit: 0.10, miss: 3.0,  out: 9.0 },
  },
  'deepseek-v4-pro': {
    current: { hit: 0.025, miss: 3,    out: 6   },
    offPeak: { hit: 0.15,  miss: 4.5,  out: 13.5 },
    peak:    { hit: 0.30,  miss: 9.0,  out: 27.0 },
  },
};
```

Update `PRICES` whenever the official pricing changes (values are CNY per million tokens).

The balance row needs the deployment's `DEEPSEEK_API_KEY` credential (`<DSH_HOME>/.credentials.yaml` or the environment) — the same credential the Harness LLM route uses. No key is stored in this package.

## Limitations

- **Costs are estimates, not billing.** The authoritative figure is the DeepSeek platform console.
- **Search-triggered usage is invisible.** The DeepSeek search provider makes direct API calls that bypass the session log; no Harness plugin can see their token usage (a DSH product limitation). Title/compaction calls *are* captured via the `llm/stream` interceptor.
- The panel hides itself in the collapsed (56px rail) sidebar.

## Development

Zero build step — `lib/index.js` and `lib/client.js` are the deployable artifacts. Syntax-check locally:

```bash
node --check lib/index.js
node --check lib/client.js
```

CI runs the same checks on every push.

## License

[MIT](LICENSE) © 2026 Ouye-UE
