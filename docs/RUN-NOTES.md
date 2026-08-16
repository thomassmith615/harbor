# run.sh, rewritten

Same checks, restructured so a stale binary can never masquerade as a passing
result.

## What changed

**The build is now a gate, not a step.** `npm install` and `npm run verify` run
in the foreground and the script exits if either fails. Everything downstream
reads `dist/`, so a broken build meant every result below it came from the
*previous* binary. That is precisely how patch 2 looked like it had landed when
it had not.

**`harbor --version` and `command -v harbor`** print right after the build, so
you can see which binary is actually on PATH and whether it matches
`package.json`.

**Step 0 hard-exits** on a missing marker instead of printing MISSING and
carrying on.

**Step 7 forces the refusal collision** rather than waiting for 3am. See below.

**Step 8 checks the daemon is actually alive** with `pgrep`, instead of assuming
it is because nothing printed.

**Step 6 is no longer truncated**, and adds a sweep across every situation for
edges resting on a single shared word, which is what an over-merge looks like.

## The refusal test was inconclusive last run, not failed

Those four rows:

```
commit  last Sun, Aug 16, 12:23 PM  ok  skipped: pulse is running
```

were written at 12:23. You installed the patch at 12:49. They are daily
schedules, so nothing has touched them since and nothing will until 3am. The
list was showing pre-patch state, not post-patch behaviour.

Step 7 now forces it: `classify` conflicts with `pulse`, so it schedules
`classify` every minute, starts a pulse, waits for the collision, and prints the
row.

- **Pre-patch:** `last <now> ok skipped: pulse is running`, next run a full
  interval away.
- **Post-patch:** no `last`, status `skipped`, next run about 5 minutes out.

It removes the temporary schedule afterwards.

## The daemon did not die

`[1]+ Done` at the end of your output was the daemon you started **manually at
12:43**, killed by `pkill` at the top of the script. The one the script started
was almost certainly still running. Step 8 now proves it either way.
