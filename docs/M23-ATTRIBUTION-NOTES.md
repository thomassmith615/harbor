# Speaker attribution

Complete file set, includes everything from M21 + M22. Safe to `cp -R` over
anything earlier. Pristine-tree verify: **154 tests, 0 failures**.

## What was wrong, precisely

Your read was right about the symptom and slightly off about the cause. Your
messages *are* stored separately: `items.direction` is inbound or outbound, and
`transcriptFor` in `derive/episodes.ts` labels every line with its speaker.

The distinction dies above that layer, in two places.

**The payload frames the whole conversation as the other person's.** The
`conversations` tool returns `with: ["Isabella Forté"]` and a transcript whose
own lines say `Me:`. In a file "Me" is unambiguous. In a tool result it is not:
"me" is whoever is talking, and a model reading a payload labelled with one name
reasonably attributes the contents to that name.

**There was no way to ask for one speaker's words.** `search` covers, in its own
description, "email messages and calendar events". Texts are not in it. So the
only route to a text message is `conversations`, which hands back a whole
transcript. The model had the labels and no reason to weight them.

## What changed

**`Me:` renders as `You:`** in every tool payload. At render time, not in
storage, so nothing is migrated and the stored transcript is untouched. Anchored
to line starts, so "tell Me: when you land" inside somebody's sentence is left
alone. That case is tested, because rewriting it would put words in your mouth,
which is the exact failure being fixed.

**`conversations` and `conversation` take `said_by`.** An entity id from
`find_person`, or `"me"`. Adds a `quotes` array holding only the lines that
person actually spoke:

```
said_by : You
quotes  : ["yes, dinner at the Kearneys, 7pm. bringing the rhubarb tart"]
```

Speaker matching is by prefix in both directions, because name resolution and
the entity display name do not always agree on whether to include a surname, and
a miss returns an empty array that reads as "they never said anything" rather
than as a bug.

**Two rules added to the ask prompt.** One on attribution: a line you spoke is
not evidence about the other person, and if the only support for a claim about
someone is something you said, that is not support. One on plans: an event's
attendees are on it; someone you texted about it is not.

Nine tests, written against the actual hot-tub transcript.

## The beach weekend needs the second rule, not the first

Worth being clear, because you'd otherwise expect one change to fix both. You
said the hot tub line *to* Issy. Attribution puts it correctly in your mouth and
Harbor is still looking at a conversation with Issy about a hot tub next to a
weekend event.

The prompt rule above covers it for now. The real fix is structural: an event
has attendees, the `gute?` event has Sam on it and not Issy, and Harbor has that
data and does not use it in reasoning. That is the next piece of work and it
wants a proper participants model rather than an instruction.

## Coyote Crossing, now diagnosed

Your explanation gave me the case: same restaurant, two visits, different
groups, a week apart, welded by the venue name.

That is not a threshold problem, and I am glad I did not tune on the numbers.
`coyote` is genuinely distinctive; the linker is right that both mention it. The
error is semantic: **a place name shared across two occasions is evidence of a
place, not of an occasion.** Neos is four edges of the same shape. `logan` is
correct, because a flight and the conversation about it are one event.

Tightening the solo-word bar would have thrown away Logan and crabbing too. The
fix is that a venue match needs temporal proximity, or that both nodes should
link to a place rather than to each other. Not in this drop.

## Corrections recorded

Neos = Cafe Neos, Conshohocken. Coyote Crossing = Mexican, Conshohocken, two
separate visits. Ward = Wards Berry Farm, Boston area. "dress dece" = dress
decent, to Issy, for the second visit. Gute = Sam Gutekunst, Poconos Airbnb.
