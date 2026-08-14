# M13: the four things wrong with sixty-five situations

Overlay onto M12:

    cp -r harbor/. /path/to/harbor/
    cd /path/to/harbor && npm install && npm run verify
    harbor dev relate --rebuild

No migration, no deletions.

## Context

M12 got the graph to roughly the right size: 6,008 edges down to 616, and
`about_same` from 5,457 to 192. Situations went *up*, 19 to 65, which was not a
regression. In M11 the `about_same` web fused everything into a few enormous
components that blew past the 40-node ceiling and were discarded. Fewer edges
means smaller, more numerous components.

Reading those 65, about two thirds were real: `camp graber`, `crabbing`,
`wear necklace`, `order pretzels`, a reminder and the conversation it came out
of. Four things were wrong with the rest.

## The volume floor was my mistake

The broadcast test required three or more messages from a sender before "you
never replied" counted, on the reasoning that below that, silence might just
mean you had nothing to say.

That reasoning is about a person and the test is about an address. Spam uses a
fresh address every time, which is exactly why a volume floor let it through: a
PCH sweepstakes, a Vegas fall-break blast, and a terms-and-conditions notice all
arrived once, all cleared the floor, and all formed situations.

There is no floor now. Inbound mail from an address you have never written to is
one-way. Reply once and it stops being one-way the same day.

## Recurring reminders count once

`rehearsal speech write ~5min` appeared four times in one situation, because a
daily reminder is four items. True, and the repetition carries no information.
The earliest instance stands for the set, earliest rather than nearest because
it does not move as new occurrences arrive, and a situation that re-forms under
a new id every morning is worse than one that is slightly stale.

## `about_same` knows about time now

Your water gauge case: one shared word, 57 days apart, drawn at 0.48. `tracks`
refused the identical pair on exactly that gap.

Two changes. One shared word more than 30 days apart is now rejected outright.
Beyond that, distance costs an edge up to a fifth of its confidence.

The penalty is deliberately gentle, and the first version was not. Multiplying
by the full fraction of the window used cost a genuine 28-day link about half
its score and pushed it under the bar for forming a situation, which would have
broken the shore-town question this is supposed to answer. Distance makes an
edge weaker, not wrong.

## Situations have names again

Four were titled things like `+13392047146`, while Harbor held 2,750 identifiers
and 1,403 resolved people and knew perfectly well that was Isabella. Handles in
a title are resolved to names at display time, a subject line beats a handle
whatever order the nodes are in, and more than three participants collapses to
"and N others".

Display only. Nothing is stored, so a rename in Contacts shows up on the next
pass with no migration.

## Verified

34 tests. Three are new and each reproduces one of the above: a sweepstakes
email that arrived once and must not link, a repeat reminder occurrence that
must not become its own node, and a single word shared across two months that
must not count as evidence.

## What to expect

Fewer situations, probably around 40, and the spam should be gone. If what
remains still needs pruning, the next move is ranking and a display cap rather
than a tighter linker: better to show the best ten of forty real ones than ten
of ten after discarding thirty good ones.
