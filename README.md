# Token Radar — pre-token protocols ranked by implied value

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/0xcqing/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/0xcqing/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A dashboard that answers one question: if a protocol's record stayed as it is, what would a token be worth, and what should a reader do to farm the protocol before or after it issues one. It does not predict whether or when a token is issued; every implied value is the model's own claim.

## What is inside

- `main.ts` — reads the sealed snapshot (`/input/snapshot.json` or `--input`), builds the ranked board, writes `board.json`, `data.js`, the dashboard, the screenshots and `dossier.json`.
- `lib/model.ts` — the valuation model: mcap/TVL medians from 144 live comparables by category and chain, adjusted for seven-day growth, protocol age, chain quality and launch independence, with a confidence score and a tiebreak that keeps implied values distinct.
- `dashboard/` — a static page (no framework, no network): ranked board, live-comparables tab, free-text search, category and chain filters, watchlist-only toggle, sortable columns and a per-protocol detail view with the model's reasoning and farm steps.
- `screenshots/` — three real renders of the page at 1440 px wide.

## Run

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

The program writes `out/board.json`, `out/dashboard/`, `out/screenshots/`, `out/data.js` and `out/dossier.json`.

## The model, in one line

Implied FDV = TVL × category median mcap/TVL × 7d growth adjustment × age discount × chain adjustment, rounded, clamped, and ranked strictly.

## Bounty

https://make.fun/bounty/token-radar-01

## Licence

MIT. See `LICENSE`.
