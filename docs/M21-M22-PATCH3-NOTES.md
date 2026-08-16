# M21 + M22, patch 3

Complete file set. Safe to `cp -R` over anything earlier.
`npm run verify` against a pristine extraction: **145 tests, 0 failures**.

## Patch 2 never ran on your machine

Your output says so in four independent places: `harbor dev relate` printed no
`carried / new` line, episode titles still show doubled counts, the four daily
passes still advanced to tomorrow after being refused, and `harbor why` on a
situation id still failed.

Everything from drop 1 works. Nothing from drop 2 does. The likely cause is the
zip name: drop 2 extracted to `~/Downloads/harbor-m21-m22-patch2/harbor/`, so
`cp -R ~/Downloads/harbor/ .` copied drop 1 again.

`scripts/check.sh` now begins by grepping for strings that exist only in this
drop, so a failed copy is the first thing you see rather than something inferred
from three unrelated symptoms.

## New in this patch: `harbor why <situation-id>`

`harbor situations` prints a `sit_` id under every heading and pasting one back
in returned "No such item or conversation." That is the worst available answer
to somebody following an id Harbor just handed them, and it is my fault for
making those ids user-facing without teaching `why` about them.

A situation is not a graph subject, so there is nothing to explain about it
directly. What there is to explain is each node in it, which is what "why are
these together" actually means. It now prints, per node, the resolved people,
shared references, distinctive words, and the drawn edges with their evidence:

```
  episode:ep_60e0d1d3a223019e
    rare words  kearney, saturday, dinner, kearneys, rhubarb, tart
    -> arranges, about_same   Dinner at the Kearneys
       this names "Dinner at the Kearneys", which is on the calendar 4 days l
       both mention kearney, dinner, kearneys, from different sources
```

That is the shape needed to judge the suspected over-merge: you can see the word
that welded two things together and decide whether it should have.

## Also carried forward from patch 2

- `recordRefusal`: a blocked schedule retries in 5 minutes, bounded to 3 hours
  from when it was due, instead of forfeiting the whole day. `last_run_at` is
  not touched, because it did not run.
- The `carried / changed / new / merged / retired` counters now print.
- Migration 026 strips stale `(N messages)` from episode titles, which also
  unblocks `isHandleTitle` and should stop situations being named after phone
  number lists.

## Your iMessage question, answered

iMessage is not broken and does not need re-authing. `harbor ask "what did I
text about crabbing"` returned a correct, sourced answer naming the person, both
conversations, and the outcome.

What is broken is the embedding backend:

```
warning: no embedding backend, using keyword search only
(Could not reach the embedding server at http://127.0.0.1:11434/v1/embeddings)
```

Ollama is down. That single fact explains most of what looked wrong:

- Retrieval falls back to keyword only, so anything phrased differently from the
  words in the messages finds nothing. That is exactly "it can't find anything
  despite knowing there's history."
- `derive` has been stuck at 759 pending, because it returns
  `skipped: no embedding backend` and does no work.
- Embeddings are frozen at 13,307 against 10,885 chunks and will not move.

`scripts/check.sh` starts Ollama if it is not running, then runs `dev derive` to
drain the backlog. Expect pending to drop and semantic search to come back.

The gate is not involved. Your policy is the three built-in rules and nothing is
being withheld.
