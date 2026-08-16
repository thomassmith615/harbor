# Attribution, plus two fixes to my own checking

Complete file set. Everything from M21, M22, and attribution.
Pristine-tree verify: **158 tests, 0 failures**.

## Your last run proved less than it looked like it did

Two of my own mistakes, both of the same kind: a check that reports success
without testing anything.

**Step 0 was checking the wrong drop.** The marker list was hard-coded in
`run.sh` and still held the list from two drops earlier. It printed four
cheerful `ok` lines about M21/M22 and said nothing whatsoever about whether the
attribution work had landed. There is now a `scripts/markers.txt` that ships
inside the drop, so the manifest and the code it describes cannot drift apart.

**Nothing verified the build.** Source can be copied without `npm run build`
taking effect, and then every result below step 1 comes from the previous
binary while step 0 says everything landed. That is precisely how patch 2
looked fine for an hour. Step 1 now greps `dist/reasoning/tools.js` for the new
symbols and dies if src and dist disagree.

**The refusal test never collided.** Twice. `classify` came due, `pulse` had
already finished, `classify` started normally, and the row said
`ok started j_...`. A pulse on a caught-up store takes seconds, so the window
this test needed had closed before the test looked. A check that only passes
when two things happen to overlap is not a check.

It is now `src/scheduler/tick.test.ts`: insert a running job row, mark a
schedule due, call `tick`, assert no `last_run_at`, status `skipped`, and a next
run minutes rather than a day away. Deterministic, no daemon, no waiting, and it
runs in CI on every drop. Three cases, including one asserting an unblocked task
still advances normally so the fix cannot silently stop everything running.

## New step 5: attribution, on your data

The one thing that genuinely needs a real store. It pulls your most recent
conversation through the actual tool path and prints:

```
  with        : ["Isabella Forté"]
  says "Me:"  : false (should be false)
  says "You:" : true (should be true)
  your lines  : 4 of 11 total
```

If `says "Me:"` comes back true, the attribution change is not in the binary
being run, whatever step 0 said.

## Still open, in the order I would take them

1. **Plan participants.** The beach-weekend confusion is covered by a prompt
   rule right now, which is a patch over a missing model. The `gute?` event has
   Sam on it and not Issy, and Harbor has that data and does not reason with it.
2. **The venue rule.** Coyote Crossing and Neos: a place name shared across two
   occasions is evidence of a place, not an occasion.
3. **launchd.** Still the last thing between you and leaving this running, and
   still the one thing I cannot verify from here.
