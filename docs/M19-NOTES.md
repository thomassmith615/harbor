# M19: the digest, and the purchases punch list

    cp -R ~/Downloads/harbor/ .
    npm install && npm run verify
    harbor dev extract
    harbor dev extract
    harbor purchases
    harbor dev notice
    harbor digest --preview

No migration. The purchase schema moved to 5, so extraction re-reads everything
under the new rules.

## Noticing was never a scheduled job

Worth stating plainly because I described it badly. Detectors run inside the
passes and queue observations as they find them. A recruiter email connects to a
job-search conversation at `relate` time, not at 7am. The schedule only ever
decided when you get *told*.

So `harbor digest --preview` is exactly "what it would say if it were
scheduled": it composes without recording or suppressing anything, which means
you can run it repeatedly while judging it. No scheduling work exists in this
milestone because none was needed.

Nine detectors run now. The milestone is reading what they say and cutting what
is wrong, the same loop that took purchases from a $4,885 total that was half
wrong to one that is not.

## Restocking

The detector the product was described by: a receipt arrives, Harbor keeps the
history, and eventually it says you are probably out of something.

It is a SQL query and a median. No model notices, which is what makes it
affordable over an entire purchase history forever.

Three restraints, because a wrong restocking prompt is worse than none:

**Merchants, not products.** Line items come from a small local model reading a
receipt and they are noisy: `16" Plain Jane`, `Mystery Hat`, `...`. A merchant
name survives that and a product name does not. Per-product restocking is the
better feature and needs an extraction layer that can be trusted.

**Four purchases before a rhythm is claimed.** Three points make a pattern out
of any two coincidences.

**Regular things only.** If the gaps vary wildly there is no rhythm to be late
for, so a restaurant visited on a whim never qualifies. That is the test with
its own case in the suite.

## The punch list

**Refunds are not purchases.** `American Airlines $676.80` was the largest line
in your report and the money went the other way: a refund for a seat selection
that did not go through. Rejected rather than negated, because guessing the sign
of the largest number in the report is not the way to begin.

**Merchant names that are not names.** `fairwaysupply@mail.pgatour` is an
address, `ParkMobile, LLC All Rights Res` is a footer, `Microsoft Corporatio...`
is a truncation. Cleaned where cleaning is unambiguous, rejected where it is
not, because the total is usually right even when the name was scraped from the
wrong line.

**Uber and Uber Technologies are one merchant.** Corporate suffixes are stripped
now. Uber Eats stays separate, because rides and takeout are different
questions.

**Order-then-ship pairs now merge.** `Choosing Keeping, 56.00 GBP` appeared on
16 and 18 March and thirty-six hours did not cover it. The window is two weeks,
and the tolerance tightens as it widens: within a day and a half a total may
grow by tax, so a quarter is right; ten days later only an identical total is
the same purchase, because similar-but-not-identical is two Uber rides and
merging those would be a fabrication.

**`harbor purchases` shows everything by default.** Ninety days hid nine tenths
of your data and said nothing about it.

## Verified

80 tests, five new, all on what restocking must refuse to say.

## 0.40.1

The first real digest, in full:

    PHILLIES was due today
    "What would you do with 100,000 points?" arrived, and before has come up
      in 20 conversations recently
    "Check Out Mike's Picks" arrived, and pretty has come up in 16
      conversations recently

One useful line and two that are absurd, which is about what the first pass over
real data has produced every time.

**"before" and "pretty" are not topics.** This file had its own stopword list
and its own corpus-share ceiling, and both let those through while
`derive/terms.ts` had been rejecting them for two milestones. Two places
deciding what a distinctive word is means one of them is wrong, and nobody finds
out until it says something ridiculous out loud. There is one test now, shared
with the relationship graph.

**Marketing mail is not news about a topic.** A flight-deals list and a clothing
brand led the digest. Both genuinely contained a recurring word and neither was
anything happening. The graph learned to ignore one-way mail in M12 and this
layer never heard about it; it uses the same index now.

**`harbor purchases merchants` still defaulted to ninety days.** I fixed the
default on the listing and not on the aggregate, so a thirty-row list summed to
two merchants. The same bug, eight lines apart, introduced in the commit that
fixed it.

## 0.40.2

The detectors were fixed and the digest said exactly the same thing, for two
reasons.

**`harbor dev notice` is not the detectors.** It reads conversations for
standing facts. `harbor dev signals` runs the detectors. Two commands whose
names both mean "notice things", and I gave the wrong one in the command block.

**Observations outlive the rules that made them.** Even with the right command,
the old findings were already queued and nothing re-examines a queued one. So
`before has come up in 20 conversations` would have survived a corrected
detector indefinitely.

Migration 024 stamps every observation with a `DETECTOR_VERSION`, and a pass
drops anything queued under an older one. This is the third layer to need
exactly this: purchases version their projections, the graph versions its edges,
and now detectors version their findings. The shared principle is that **a rule
which stops producing something cannot retract what it has already produced**,
so every layer that derives needs a version that invalidates.

Dismissals are deliberately left alone. Someone who has said "not worth saying"
judged the finding, not the version of the code that found it, and re-asking
would be the most annoying possible behaviour.

## 0.40.3

`harbor dev signals` failed with `no such table: thread_items`.

The `upcoming_loose_end` detector, the one the graph exists for (a meeting soon,
arranged in a thread where the last word was someone else's and you never
replied), has been dead since migration 023 renamed that table in M9. Four
milestones. Nothing noticed, because SQL is a string: typecheck cannot see it,
the build cannot see it, and the only symptom is a person running the pass.

Fixed, and more usefully, there is now a test that runs **every** detector
against a real store and asserts only that it can be run at all. That is the
exact property that was silently false, it takes milliseconds, and it would have
caught this on the day it broke. Two more tests cover the version mechanism:
older observations are retracted, and dismissals are not.

This is the same shape as the missing import test in M14: a whole category of
failure that lives outside what the type system can see, caught by the cheapest
possible check once somebody thinks to write it.
