# M8: what Harbor knows about you, and what keeps coming up

    cp -r harbor-m8/. /path/to/harbor/
    cd /path/to/harbor
    npm install && npm run build
    harbor remember "Does not eat pork" --kind constraint
    harbor notice --dry-run

Migration 022 runs on the next database open. Includes M1 through M7 unchanged.

## Two things

**Standing facts.** A dietary restriction, which airport you fly from, that a
name is a landlord rather than a friend. They change rarely, apply everywhere,
and are the reason a system used for a year answers better than one used for a
week.

The design is about trust rather than storage. A fact found in conversation is
`proposed` and does nothing at all. Only `confirmed` facts reach a model. Harbor
may notice; it may not decide. Rejection is permanent, verified: re-recording a
rejected fact returns it still rejected rather than resurrecting it.

Health, finances, religion, politics, and other people's circumstances are
excluded by the extractor and checked again after it. A model told not to do
something mostly complies, and mostly is not good enough here.

**Recurring subjects.** The example from your original brief, working: a subject
that has come up across several conversations, plus a recent email from a
different source that mentions it. Deterministic, counting distinct
conversations rather than clustering embeddings, so the evidence is a list you
can open rather than a similarity score.

Verified output from a seeded store:

    "Your Vermont cabin enquiry" arrived, and vermont has come up in
    5 conversations recently

## Two bugs I hit building it

The corpus-share test excluded every real topic on a small store: with five
conversations, a term in four of them is 80% of the corpus and got dismissed as
vocabulary. The test now only applies once there are 50+ conversations, which
there will be on your machine and were not on the demo.

One email matched "vermont", "stowe", and "cabin" and produced three
near-identical observations. Now one observation per piece of mail, strongest
topic wins.

## New surface

    harbor remember <statement> [--kind ...]
    harbor facts [--proposed] [--rejected]
    harbor notice [--dry-run] [-n 20]
    harbor confirm <id> / harbor reject <id> / harbor forget <id>
    harbor topics

Confirmed facts are injected into the ask system prompt, constraints first,
capped at 20 lines. `notice` joins the job runner and the schedule (5am),
bounded to 10 conversations per unattended run.
