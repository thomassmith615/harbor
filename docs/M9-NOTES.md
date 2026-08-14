# M9: the graph learns to cross a source boundary

Replace your Harbor folder with this one. Migration 023 runs on the next
database open, and it rebuilds two tables, so an overlay copy is not safe.

    mv harbor harbor-old
    unzip harbor-m9.zip
    cd harbor && npm install && npm run verify

Your store is not touched beyond the migration. Existing edges migrate. Then:

    harbor dev relate --rebuild
    harbor situations

## What was actually wrong

Not "the linker requires shared people", which is what the last review said. The
truth is worse and the fix is different.

No generator ever produced a message-and-event pair. A calendar entry typed into
Calendar.app has no attendees, so it has no entities, so the entity generator
could not see it; it is in no mail thread and shares no confirmation code. So
`arranges`, described in its own docstring as the most valuable edge in the set,
was unreachable code. It was not rejecting pairs. It never received one. Its
rejection message has probably never been written to disk.

That is why zero of 35,898 edges joined a message to a calendar entry, and why
35,784 of them were `same_thread`: thread adjacency was the only generator that
reliably fired, and it restates what Messages and Gmail already show.

## Three changes

**Nodes.** An edge now joins an item *or an episode*. Messages in a
conversational source are represented by their episode and are not graph
subjects. On your store that is 218,000 messages replaced by a few thousand
conversations: roughly twenty times less work, and the only version that can draw
a meaningful edge, because one text carries no linkable content and a
conversation does.

**Content candidates.** A new generator finds nodes sharing distinctive words
inside a wide time window, searching `items_fts` and `episodes_fts` separately so
an event arriving after a conversation still finds it. Rarity is measured against
your own store: a word counts as distinctive below 2% of the corpus, floored at 5
and capped at 500.

Not embeddings. A cosine score is not evidence anybody can check.

**`arranges` no longer requires a person.** Naming the event, or sharing
distinctive vocabulary, is now sufficient. A shared person raises confidence
rather than gating it.

## Verified

`npm test`. Twenty-three assertions against a synthetic four-source store, about
a second, no credentials and no model server. The graph it produces:

    arranges          0.85  conversation <-> "Dinner at the Kearneys"
        this names "Dinner at the Kearneys", which is on the calendar 4 days later
    shares_reference  0.95  "Your trip confirmation" <-> "Itinerary update"
        both mention NKQ8ZT2                              (141 days apart)
    tracks            0.70  "About your appointment" <-> "Reschedule dentist"
        share reschedule, dentist, appointment

Four of five edges cross a source boundary. The newsletter and the chat that says
only "haha ok" connect to nothing, which is asserted rather than hoped for.

## Also in here

- **Self-handles.** Connectors may now declare which addresses and phone numbers
  belong to you. iMessage reads `chat.account_login`, which is where your own
  number lives. An outbound text has no author, so your phone number was never an
  identity anchor and "have I replied to them" was unanswerable for the source
  where most replying happens.
- **`harbor update`**, which is the nine-stage incantation with a name that says
  what it does, and which tells you what already works while history fills in.
- **`harbor why <id>`**, promoted from a flag buried on a pipeline stage.
- **`harbor dev <stage>`**, holding the twelve commands that describe Harbor's
  internals rather than anything a person wants.
- Duplicate reasons collapse in display. Two linkers agreeing is better evidence
  and worse reading.

## The parameter most likely to be wrong

The rarity ceiling in `src/derive/terms.ts`. Too loose and you get "both mention
Philadelphia"; too tight and it misses. It is one constant, `harbor why` prints
what it decided, and the fixtures are more permissive than your store will be
(with thirteen documents the ceiling is 5, so "dinner" counts as distinctive; with
40,000 it will not).

Shipped slightly tight on purpose. A wrong edge is worse than a missing one.

## Next

M10 collapses the noun commands (`commitments`/`commitment`, `people`/`person`/
`merge`/`rename`) and gives `connect` a real interactive walkthrough. M11 is
encryption at rest, which should not slide again.
