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

## Running it

```
harbor init          set up the store
harbor connect       authorize your sources        (currently: harbor auth <source>)
harbor update        bring everything up to date
harbor ask "..."     the actual product
```

`harbor update` runs the whole pipeline in the only correct order. Recent mail,
messages, calendars, and reminders come first, so Harbor is answerable within a
minute or two; older history fills in behind you. `harbor jobs` says what it is
doing, `harbor status` says what it holds and how far back.

Requires Node 20.11 or later. `npm install && npm run build`.

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
wrong about; "both mention Kearneys" can.

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

Credentials live in the system keychain. Backups are encrypted. **The store
itself is not encrypted at rest**, which is a deliberate and currently
outstanding decision: a stolen laptop reads everything. `harbor doctor` restates
this every run until it is fixed.

One gate, one chokepoint, no bypass. Every item on its way to a model passes
through `src/policy/gate.ts`, which decides, redacts, and reports what it did.
An unconfigured gate withholds rather than admits. A model that was denied
something is told so, because a model that does not know it is missing items
answers as though it saw everything.

```
harbor policy list       what may leave this machine
harbor audit             every model call, what it cost, what it saw
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

- The store is not encrypted at rest.
- Household support is schema, custodian, visibility, and search scoping only.
  Entity resolution, commitments, detectors, and the digest all assume one
  person.
- `src/cli/main.ts` is one large file and the command surface is still larger
  than an appliance warrants. The pipeline stages have moved behind `harbor dev`;
  collapsing the nouns is next.
- `src/actions/` (write actions) is present, unfinished, and unused.
- Gmail attachments are referenced but not fetched.
