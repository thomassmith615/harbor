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

Three views. **Ask** is the product, and it streams what it is reading while it
reads it. **Sources** shows what is connected, when each last synced, and
connects new ones without a terminal. **Run** has four operations (sync, fill in
history, rebuild links, back up), what is running now, and what has run recently.

The page is three files in `src/surfaces/ui/`, served by the daemon from the
same origin as the API. No build step, no bundler, no second repository: one
`npm run build` produces the daemon and its interface together, which is the
only arrangement where they cannot be different versions of each other. An
earlier separate front end fell six milestones behind the API and was shelved.

Operation status lives in SQLite rather than in the page, so a browser refresh
shows the same running job at the same progress. Chat history does not persist,
deliberately: conversations are stored server-side and `harbor ask` reads them,
but a reload starts a fresh thread.

To leave it running and reach it from a phone, see `docs/RUNNING.md`. The short
version is `harbor install-service` plus Tailscale, which keeps Harbor bound to
loopback and still gives you a real HTTPS address from anywhere.

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
