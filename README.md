# Harbor

A local intelligence appliance for one person's digital life.

Harbor reads the sources you authorize (messages, mail, calendars, reminders),
keeps everything on your machine, and connects what it finds across them. The
product is not the copies. It is the connections: an email, a calendar entry,
and a text about the same weekend are one thing, and no single application can
see that.

Everything derived is rebuildable from what was fetched. Every claim carries the
evidence it was built from. Nothing leaves this machine except through one gate,
and that gate is audited.

Running against a real store: ~42,000 items across five sources, 2,283
conversations, and 49 situations that span more than one source. 176 tests.

## What is worth looking at

If you are reading this to see how it is built rather than to run it, these are
the parts with actual decisions in them.

**Situations have durable identity.** A situation is a connected component of
the relationship graph, recomputed every pass. Its *id* is not: components are
proposals, and a matcher carries ids forward by membership overlap, so a
situation you renamed or dismissed survives being re-derived. The id used to be
a hash of its contents, which meant one new message destroyed it and every
dismissal silently came back. `src/derive/situations.ts`.

**Every edge carries readable evidence.** Links between items are drawn by
deterministic linkers, not by asking a model, and each records why in a sentence
a person can check: *both mention a rare word, from different sources, eight
days apart*. `harbor why <id>` replays what was considered and what was
rejected, using the same code the pass uses, because an explanation derived from
a second implementation eventually describes a system that no longer exists.
`src/derive/relate.ts`.

**Retrieval is hybrid and knows what it is missing.** Lexical and semantic
search combined, with a coverage model so Harbor can say a search ran over an
incomplete picture rather than implying it saw everything. `src/retrieval/`.

**Models are a replaceable component with a cost ladder.** Tasks declare the
cheapest tier that might work and the capabilities they need. Structured
extraction starts on a 3B local model at zero cost; when an answer fails
verification it retries one tier up, climbing to a larger local model before it
spends anything at all. Escalation is an outcome, not a prediction.
`src/reasoning/router.ts`.

**Extraction is verified, not trusted.** A model reading a receipt will invent a
total. Every extracted purchase is checked against the source text and rejected
if the number does not appear in it. `src/projections/purchase.ts`.

**One egress gate.** Content reaching a cloud model passes a single policy
check: restricted items are withheld, sensitive ones redacted, and the model is
told what it did not get so it cannot answer as though the picture were
complete. `src/policy/gate.ts`.

**Speaker attribution.** A transcript is several people talking. Something you
said is not evidence about the person you said it to, so tool payloads label
your own lines unambiguously and expose a per-speaker filter. This was a real
bug: asked what somebody liked, Harbor answered from things the user had said to
them. `src/reasoning/tools.ts`.

The comments throughout explain why a thing is the way it is, usually including
what the previous attempt got wrong. That is deliberate and it is where the
reasoning lives: there is no separate design document to fall out of date with
the code, because a comment that contradicts the function under it gets noticed
and a document that contradicts the system does not.

## Running it

```
harbor init                set up the store
harbor auth <source>       authorize a source
harbor update              bring everything up to date
harbor ask "..."           the actual product
```

Then the nouns, each of which lists by default and takes an id:

```
harbor situations          what spans more than one source
harbor commitments         what you said would happen and has not
harbor conversations       what was discussed
harbor purchases           what was bought, and what it cost
harbor people              who is who
harbor digest              the few things worth knowing
harbor doctor              what is broken, exposed, or behind
```

`harbor settings` holds everything about how Harbor behaves (schedules, egress
policy, detectors, models, spend, secrets). `harbor dev` holds the pipeline
stages and diagnostics, which describe Harbor's internals rather than anything a
person wants. Thirty-one top-level commands, down from ninety-two.

`harbor update` runs the whole pipeline in the only correct order. Recent mail,
messages, calendars, and reminders come first, so Harbor is answerable within a
minute or two; older history fills in behind you. `harbor jobs` says what it is
doing, `harbor status` says what it holds and how far back.

Requires Node 20.11 or later. `npm install && npm run build`.

## The interface

```
harbor daemon
```

Then open `http://127.0.0.1:8484`. It asks to be paired; on the machine running
Harbor, `harbor device code --act` prints a short-lived single-use code.

Four views. **Ask** streams what it is reading while it reads it. **Noticed** is
the half that does not wait to be asked: the nightly digest, and every situation
Harbor has assembled, each one opening to show what is in it and the evidence
for why. **Sources** shows what is connected, when each last synced, and connects
new ones without a terminal. **Run** has four operations (sync, fill in history,
rebuild links, back up), what is running now, and what has run recently.

Noticed is where the cross-source claim is checkable rather than asserted. A
situation is a claim Harbor made about your life using rules you did not write,
and the difference between that being useful and being unsettling is whether you
can see what it was reading. Every edge carries a sentence a person can read, and
that sentence sits under the thing it explains.

The page is three files in `src/surfaces/ui/`, served by the daemon from the
same origin as the API. No build step, no bundler, no second repository: one
`npm run build` produces the daemon and its interface together, which is the
only arrangement where they cannot be different versions of each other. An
earlier separate front end fell six milestones behind the API and was shelved.

Operation status lives in SQLite rather than in the page, so a browser refresh
shows the same running job at the same progress. Chat history does not persist,
deliberately: conversations are stored server-side and `harbor ask` reads them,
but a reload starts a fresh thread.

To leave it running and reach it from a phone: `harbor install-service`, then
`harbor remote`. The second checks the path from outside and prints whichever
step is missing. Underneath it is Tailscale on its free plan, which keeps Harbor
bound to loopback and still gives you a real HTTPS address from anywhere. See
`docs/RUNNING.md`.

## What it holds

| Source | What it reads |
| --- | --- |
| iMessage | The local `chat.db`, read-only, via a snapshot |
| IMAP | Any mailbox; autoconfigured from the address where possible |
| Apple Calendar and Reminders | CalDAV, with an app-specific password |
| Apple Contacts | CardDAV. Small, and it turns addresses into people |
| Google | Gmail and Calendar. Supported, deliberately not in any default path |

Adding a source means implementing five methods. See `src/connectors/types.ts`.

`HARBOR_HISTORY_MONTHS` (default 6) bounds how far back every source reads.
Raising it later costs only time: clear a cursor and re-sync, and the store fills
in behind what is already there.

## How it thinks

Six passes, each versioned, incremental, resumable, and rebuildable from stored
text without re-fetching anything.

**classify** labels every item's sensitivity by rule, because the gate withholds
anything unlabelled.

**derive** segments conversations into episodes, then chunks and embeds. A text
message is not a unit of meaning: "yeah saturday works" says nothing alone, so
the episode is what gets embedded, not the message.

**resolve** extracts the people involved. An address or a phone number is an
identity anchor; a name is not. Two people called John Smith stay two entities
until they share an address or you run `harbor merge`. This deliberately
under-merges, because welding two people together produces confident,
well-sourced, wrong answers and nothing in the output looks off.

**relate** draws edges between nodes and groups them into situations. See below.

**commit** assembles commitments: something said in a conversation, a reminder
written to not forget it, a calendar entry that formalizes it, and mail that
confirms it are one obligation with four pieces of evidence.

**extract** reads receipts into structured purchases that can be summed. A
deterministic predicate decides what is worth reading before any model is
called, which is why this reads under 1% of a mailbox.

Individual stages live under `harbor dev <stage>` and exist for working on
Harbor, not for using it.

## Stories

The graph below answers "are these two things connected". That turned out not to
be the question. The question is "what happened", and the difference is not one
of degree.

A connected component of a similarity graph is single-linkage clustering, and
single-linkage chains: A resembles B, B resembles C, and now A and C are one
situation despite sharing nothing. Every guard against that — a forty node
ceiling, a required spine kind, a two-source minimum — fights the symptom. On
sparse data those guards throw away real stories; on dense data chaining happens
underneath them anyway. Grabbing too much and grabbing too little are the same
defect seen from two sides.

So the unit changed. A **story** is not a component. It is a *frame* built around
something that inherently defines an occasion — a journey, a calendar entry —
plus everything that points at that frame's anchors. Membership is a claim about
the story, never about another member, which is what makes chaining structurally
impossible rather than merely bounded.

```
harbor stories             journeys and occasions, most salient first
harbor stories show <id>   everything in one, in order, and why each part is in it
harbor stories why <id>    what was considered and turned down, and on what grounds
harbor presence [date]     where you are over time, and how sure Harbor is
```

**An anchor is a typed claim.** Not "these texts share a rare word" but: this
happens at this place, over this span of days, carries this identifier, involves
this person. `BOS`, `Boston` and `Logan` collapse to one place anchor; "the 20th
through the 24th" becomes a span rather than being discarded as a bare number.
The kind of an anchor says what it is worth, which is the distinction the old
design could not express because topic overlap was the only evidence it had.
`src/derive/anchors.ts`.

**Admission needs two independent kinds of evidence, or one decisive one.** That
single rule is the quality control. Shared vocabulary is one kind and is capped
below the bar, so a node whose only claim is words in common can never get in,
however many it shares. `src/derive/gather.ts`.

**Position is evidence.** A reminder three hours before a departure is about the
departure, and it shares no word with it — there is nothing in common to
discover. `pack laptop` is admitted on where it sits. Under the old linker it was
rejected by arithmetic: `tracks` required two content words of five or more
characters from the reminder to appear in the other node, and "pack laptop"
yields one.

**Co-location is not evidence.** While you are in Boston, everything around you
mentions Boston, so the place anchor stops discriminating at exactly the moment
it looks strongest. A cold sales text mentioning the Boston area, sent mid-trip,
scored "mentions Boston" plus "was said during it" and walked straight in. Both
statements true, conclusion wrong. Mentioning the destination weeks beforehand
is a real signal; mentioning it while standing there is small talk.

**A frame learns who it is with.** A calendar entry for a flight has no
attendees, so a trip starts out knowing where and when and nothing about who —
and the person test, one of the strongest signals available, could never fire for
the frame kind that needs it most. One round of enrichment fixes it: a
conversation that joined on place and dates names the person you are going to
see, and the frame then recognises the eight other conversations with them that
said nothing geographic at all. People are harvested only from conversations, and
only once, because iterating to a fixed point is how a frame walks off into the
rest of the store one plausible hop at a time.

**Presence is derived from journeys.** Intervals, not connections: away here,
home from then, with each interval marked `observed` (a journey said so) or
`inferred` (nothing said otherwise). The distinction is what makes it safe to
build on — "no evidence of travel" and "evidence of no travel" are different
claims and only one of them is true. `src/derive/presence.ts`.

**Presence is a timeline, so it may not overlap itself.** Trips are allowed to
overlap; a sequence of where somebody was is not. Two trips to London whose
spans crossed produced two "away in London" intervals stacked on each other, one
of which had to be wrong and neither of which said which. And an unfinished
journey now expires: a single unpaired flight in April used to make every
question after it answer "away in Boston" — in August, four months and several
trips later — because the sentence never changed, nothing about it looked wrong.

**One picture, not several.** A lakehouse weekend appeared under "what happened"
and was absent from "where you have been" — two answers to one question. The
cause was that each pass read the raw store and none read what the others had
worked out. Three seams, all now closed:

- *A name in a sentence reaches the person.* Harbor knew who a message was sent
  to and nothing about who it was about, so "going up with Luther" contributed
  the two people in the header and not Luther. The thread with the man actually
  going was unreachable from the sentence naming him. `src/derive/mentions.ts`
  indexes only name forms that point at exactly one person and are not ordinary
  words — a wrong person is worse than no person.
- *A frame learns where it was.* Gathering is where a frame finds out who it was
  with and where it happened, and presence was being handed the frames as
  *detected*, so anything learned came too late to count.
- *Position bootstraps the thin ones.* A calendar entry reading "gute?" carries
  almost no anchors, so nothing joins it on subject, so it never learns a
  subject. Admitting the conversation immediately before it is the one move that
  gets the first fact in the door — and everything the frame then knows, it
  learned from that.

The chain that results is the point: position pulls in one thread, that thread
names a person, the person's name in a *different* thread pulls that one in, and
that thread is the only thing in the store that says where any of it happened.

**Completeness beats interestingness on the upcoming surface.** The story layer
holds a high bar — two independent kinds of evidence, or one decisive one — and
that bar is right for a claim about somebody's life assembled from scattered
parts. It is wrong for "what is coming", and getting it wrong produced the worst
failure Harbor has had: a calendar entry reading "Smith cousin weekend" two days
away gathered no cross-source evidence, so it was not a story, so it appeared
nowhere. The chat found it instantly. The one surface meant to stop somebody
forgetting what is ahead was the one place it was invisible, *because* it was
uncomplicated. `src/derive/upcoming.ts` is the calendar and the reminders, with
stories folded in where they exist.

**A wedding is not four things.** A welcome party on Friday, a ceremony on
Saturday afternoon and a reception on Saturday evening were three stories plus a
fourth called "Graber wedding". Contiguous occasions that share a place or a
person now merge before gathering, so the combined frame gathers once against
everything it is about.

**A story may be named by a model, and only named.** `name.ts` refuses to
generate titles, on the grounds that a model asked to name something produces a
label that outruns the evidence. Sound — and it also produces "Concur Travel
Itinerary" as the name of a work trip and "gute?" as the name of a weekend away.
No amount of choosing a *different* existing string fixes it, because on a
weekend containing three events none of the three strings names the weekend. So
the boundary moved by exactly one step: a generated title is written with
`title_source = 'model'`, no derivation reads it, no anchor is built from it, no
scoring sees it, and the evidence sits underneath ready to contradict it.
`src/derive/name-stories.ts`.

**Evidence is layered, and the layers are not equal.** Three of them now, in
descending authority, and which one speaks decides how strongly Harbor puts it:

1. *A calendar journey.* A real departure time. Sets trip boundaries.
2. *A booking.* Names the trip and can date one the calendar never saw — but
   where both speak, the calendar wins. A confirmation is *about* a journey;
   the calendar entry *is* one. Conflating the two put a Boston weekend on the
   3rd because a fare rule in the email said August 17, and left three
   overlapping trips for one weekend.
3. *Something the person said.* "driving home" is how most journeys are
   actually recorded: no booking, no calendar entry, no identifier. Signals
   never build stories — a sentence should not reorganise a week — but they
   close journeys that were left open and stand in for ones nobody recorded,
   marked `inferred` on the timeline. Outbound messages only: an inbound
   "driving home" is somebody else's evening. `src/derive/signals.ts`.

**What a real store taught the layer**, none of which a fixture would have:

- The same flight arrives more than once. The airline mails an itinerary, its
  calendar feed publishes an entry, a second subscribed calendar publishes it
  again. Each copy became an outbound and paired with a different copy of the
  return, so one weekend in Chicago was three identical trips.
- A return has to be *chosen*, not taken first. Ranking candidates by whether
  they depart from where the outbound landed, inside a twenty-one day window,
  is what stops a Boston weekend pairing with a leg twenty-seven days later.
- Rarity stops meaning anything once the corpus is HTML. A trip listed `roboto`,
  `montserrat` and `fb2605914` among its subjects: font stacks from an inline
  stylesheet and a tracking id from a pixel, all genuinely rare, none a topic.
- Automated senders are not noise, but a circular is. The rule that readmitted
  airline confirmations also readmitted "Top 10 restaurants with a scenic view".
  Mass mail now joins on an identifier or on being a booking, never on subject.
- Timestamps predate the person. Presence began in October 2001, from a contact
  card birthday. Five years is the horizon.
- Nobody is in Boston three times at once. Overlapping trips to one place are a
  contradiction, not a coincidence, and merge to the *narrowest* span — widening
  on the least reliable member is how a four-day weekend became a week and then
  reached further back for evidence that did not belong.

The fixture in `src/fixtures/trip.ts` is the scenario written down: a packing
reminder, a flight hours later, two months of texts working out an itinerary, and
a flight back. Half its assertions are memberships it *forbids* — a newsletter, a
recurring standup, and a stranger who mentions the destination during the trip
week.

## The graph

An edge joins two **nodes**, and a node is an item or an episode. That
distinction is the difference between a graph of conversations and a graph of
fragments: messages in a conversational source are represented by their episode
and are not linked individually.

Six linkers, all deterministic, each producing evidence a person can read:

| Edge | Drawn when |
| --- | --- |
| `same_thread` | The source says so. Adjacent items only, never in a conversation |
| `shares_reference` | Both carry the same flight number, confirmation code, or tracking number. Holds across any distance in time |
| `arranges` | A conversation or mail plausibly set up a calendar entry |
| `tracks` | A reminder covers what something else says |
| `about_same` | Both use the same distinctive words, across a source boundary |
| `adjacent` | Same person, minutes apart, different sources |

Rarity for `about_same` is measured against your own store, not against English.
"Wegmans" is a common word in a Philadelphia mailbox and a distinctive one
elsewhere, and only your corpus knows which. The ceiling is 2% of the store,
floored at 5 and capped at 500; `harbor why` prints what it decided.

Deliberately not embeddings. A cosine score cannot be checked by the person it is
wrong about; "both mention Brennans" can.

A **situation** is a connected component of that graph spanning more than one
source. One source is a conversation, and Messages already shows it better than
Harbor would.

```
harbor situations        what spans more than one source
harbor related <id>      everything connected to something, and why
harbor why <id>          what was considered, and why it was not connected
```

`harbor why` is the first thing to reach for when an answer looks wrong. It runs
the real generators and the real linkers, writes nothing, and reports both the
edges drawn and the reason each rejection happened.

## Privacy

Credentials live in the system keychain. Backups are encrypted. The store can be
encrypted at rest:

```
harbor settings encryption --enable
```

That rewrites every page of the file in place and puts a 32-byte key in the
keychain. FTS5, WAL, and the vector index all keep working; without the key the
file is not a database.

**Lose the key and the store is gone.** There is no recovery, by design, because
a recoverable key is a second copy of the key. The command prints it once so it
can be written down somewhere that is not this machine.

One gate, one chokepoint, no bypass. Every item on its way to a model passes
through `src/policy/gate.ts`, which decides, redacts, and reports what it did.
An unconfigured gate withholds rather than admits. A model that was denied
something is told so, because a model that does not know it is missing items
answers as though it saw everything.

```
harbor settings policy   what may leave this machine
harbor settings audit    every model call, what it cost, what it saw
harbor doctor            what is broken, exposed, or behind
```

## Models

No file outside `src/reasoning/router.ts` and `tasks.ts` names a model. Code
declares a task class; the router resolves it to the cheapest tier that
satisfies its capability and privacy requirements.

Honest status: the ladder is correct as a design and is currently a capability
filter rather than a cost router. Two task classes have live callers, and the
expensive work is already bounded by free deterministic predicates. Shadow
sampling and quality demotion are implemented and have no workload. Do not read
the tier list as a description of current behaviour.

Local models speak the OpenAI chat-completions shape, so Ollama, llama.cpp, and
LM Studio all work: set `HARBOR_LOCAL_URL`.

## Working on it

```
npm run typecheck
npm test             build, then run the suite
npm run verify       all three
```

The tests run against a synthetic store in `src/fixtures/`, seeded across four
sources, with every cross-source connection Harbor is meant to find written down
as an assertion. They take about a second and need no credentials, no model
server, and no real data.

This exists because the previous milestone was verified by running the whole
pipeline against 218,000 real messages on one particular Mac and reading the
output. That loop takes half an hour, needs somebody's actual life in it, and
cannot be run by whoever is writing the code, which is how the relationship
layer shipped twice with a defect that made its flagship behaviour impossible.
Both times it looked fine.

Half the value is in the edges the fixtures **forbid**. A newsletter and a chat
that says only "haha ok" must connect to nothing.

## Things that must not be simplified away

- Every `--dry-run` and `--explain`. They are the only way to check a
  deterministic layer before it spends money.
- The distinction between proposed and confirmed facts. Harbor may notice; it
  may not decide.
- Evidence on every claim. That is what makes a wrong answer traceable rather
  than arguable.
- The deterministic-first stance. Detectors, linkers, and candidate predicates
  stay rule-based, with models confined to extraction that can be verified
  against source text.
- Principal scoping inside the SQL. Not a post-filter, ever.

## Known gaps

- The story layer knows two frame kinds, trip and occasion. Orders and
  deliveries are an obvious third and are not built; purchases already have
  their own projection.
- A journey needs a calendar entry, or mail that states a date. An airline
  confirmation with no date in it and no matching calendar entry produces no
  trip, because a leg without a departure time is not a leg.
- Two destinations in one holiday are two trips. Without knowing intent that is
  the honest reading, and it is still a limitation.
- The gazetteer in `src/derive/places.ts` is hand-checked and US-centric.
  Somewhere it does not name falls back to being an ordinary topic term, which
  is the correct failure but is a quieter one than it looks.
- Position is never sufficient on its own for a reminder. It was, to rescue
  "pack laptop", and as a general rule it is indefensible: something is always
  about to happen, so every note inside three days of any occasion joined it —
  a zucchini brought home from work, a domain to check, somebody's birthday.
  What distinguished the packing reminder was never proximity; it was that
  packing is something you do *for* something.
- Prep plus a familiar person is not evidence either. Somebody you text daily is
  always "involved", so two weak positives multiplied into confident wrong
  answers. Beyond the few hours where position speaks for itself, a conversation
  has to say something about the occasion, not merely happen near it.
- A plan is not a memory. The timeline had no notion of now, so a flight booked
  for November sat in "where you have been" beside a weekend in August.
- Conversations get two prep windows: inside fourteen hours, position admits
  them alone; out to thirty-six, position counts but something must corroborate.
  "Is evidence" and "is enough on its own" are different questions.
- A period away inferred from text has no destination unless the sentence
  happened to name one, so it shows as "somewhere else". Naming it would need
  signals Harbor does not read: photo locations, where money was spent.
- Stories and situations both exist and answer the same question differently.
  That is deliberate for one milestone and should not survive two.
- Household support is schema, custodian, visibility, and search scoping only.
  Entity resolution, commitments, detectors, and the digest all assume one
  person.
- `src/cli/main.ts` is still one file of about 4,700 lines. The surface it
  registers is now the right shape; the file is not.
- `harbor auth` is three source-specific flows on the command line. The web
  interface does have the single connect flow this gap describes, so the
  duplication is now the problem rather than the absence.
- Gmail attachments are referenced but not fetched, and a good share of receipts
  are PDFs.
- Harbor reads and never writes. Write actions were removed rather than left
  half-finished; if they come back it should be deliberately.
- A source whose connector no longer exists keeps its items and can never be
  refreshed. Harbor marks it dormant rather than reporting it as perpetually
  stale, which is honest but is not the same as being able to clean it up.

## License

MIT. See `LICENSE`.
