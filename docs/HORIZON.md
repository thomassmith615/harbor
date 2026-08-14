# One history horizon, default six months

Apply on top of M8:

    cp -r harbor-horizon/. /path/to/harbor/
    cd /path/to/harbor && npm run build

No migration. Three files: `src/connectors/engine.ts`, `README.md`,
`package.json` (0.30.1).

## What was wrong

`backfill` mode passed **no window at all**. Every other mode had one and every
connector already honoured it, but "sync this source" meant "read everything
that has ever happened". On 218,779 messages and 38,088 emails that is not a
setting anybody chose; it is just what happens.

`HARBOR_HISTORY_YEARS` existed and defaulted to ten, and only the `historical`
mode ever consulted it.

## What it does now

`HARBOR_HISTORY_MONTHS`, default 6, governs every source and every mode.

    HARBOR_HISTORY_MONTHS=24 harbor sync --backfill    # two years
    HARBOR_HISTORY_MONTHS=0  harbor sync --backfill    # no limit (old behaviour)

Verified: unset and garbage both fall back to 6, `1` gives a one-month floor,
`24` gives two years, `0` gives none. Zero and NaN do not share a fallback,
because zero is a real choice.

The recent pass is clamped by the horizon, so a one-month horizon does not hand
you ninety days anyway.

Contacts stay unwindowed. They carry no useful timestamps and are what turns
addresses into people, so windowing them would slow nothing and make every other
source worth less.

## Changing it later

Costs only time. Clear a source's cursor and re-sync, and the store fills in
behind what is already there. Lowering it discards nothing: the horizon governs
what is fetched, never what is kept.

## Before you re-run

Your IMAP stream has a partial backfill cursor from the interrupted runs. The
horizon applies to what it fetches from here, so it will finish quickly, but the
2,450 items already ingested stay regardless of age. If you want a clean
six-month picture, wipe and re-sync.
