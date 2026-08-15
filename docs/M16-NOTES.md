# M16: the extraction never had a chance

Overlay onto M15:

    cp -r harbor/. /path/to/harbor/
    cd /path/to/harbor && npm install && npm run verify
    harbor dev preflight
    harbor dev extract

No migration.

## What the last run said

    Considered 50, Read 50, Purchases 0
    Rejected 43 that failed verification
      response was not JSON  (x43)
    Model qwen3:4b via local_small
    Took 23m 32s

Three separate faults, all visible in those five lines.

## The model was thinking out loud

`qwen3:4b` is a reasoning model. It emits a `<think>` block before its answer,
so every response began with prose and `JSON.parse` died on the first character.
It also spent roughly 28 seconds per item generating reasoning nobody read.

The step-back document named this a week ago: "the local model name is hardcoded
and unchecked, which cost a whole test run". I read it, agreed with it, and
shipped four milestones without fixing it.

Two changes, and the second matters more. Requests now ask the server to turn
reasoning off, in the three spellings Ollama, llama.cpp and LM Studio disagree
about. And `reasoning/json.ts` finds the JSON in whatever comes back anyway:
reasoning blocks, code fences, a friendly sentence, or an object embedded in
prose.

That second part is the durable fix. A model's job is to produce the content and
the caller's job is to find it, because the caller is the only one of the two
that can be relied on. Prompting reduces how often this is needed and never gets
it to zero, and the failure mode when it does happen is a silent empty result.

It is deliberately not a JSON repair library. Malformed JSON is reported as a
failure rather than guessed at, because guessing means inventing purchase
records, which is much worse than extracting none.

## Text messages were queued for receipt extraction

`Remaining 23,705 items` after a pass that had finished. The projection queue
was every message in the store, so 35,000 texts sat in it forever: the predicate
marks a bounded pool per run, and a quarter of the store could never leave. A
completed job looked like one percent progress.

The queue is now email only, which is the same reasoning as the relationship
graph one layer down: the unit of work should be things the pass can possibly
say something about.

## A preflight check that would have caught it

`harbor dev preflight` now asks the configured local model for the smallest
possible JSON object and reports what actually comes back. Clean JSON passes.
JSON wrapped in a reasoning block passes with a warning, because it works and is
slow. Anything else is a problem, named, before you spend 23 minutes finding
out.

## Verified

53 tests, ten of them new, one per shape a model actually returns: a reasoning
block, a code fence, both plus a friendly sentence, a brace inside a quoted
string, an escaped quote, a truncated trace with no answer, malformed JSON, and
two responses in a row (a global regex carries `lastIndex`, which would have
made every second extraction skip the check).

## 0.37.1

**The thing that kept destroying the store key was `npm run verify`.**

The encryption tests create a store in a temp directory, encrypt it, and save
the key they generated. `HARBOR_HOME` is temporary; the keychain is machine-wide.
So every test run wrote a random key over the real store key, and every guard
looked at that write and approved it, because in context it was a perfectly
valid key for a perfectly real store. It just was not this one.

That is why the timestamps landed on `harbor --version` and `harbor dev
preflight`: those commands ran seconds after a `verify`, and the write belonged
to the verify.

The keychain service name is now scoped to the installation: `harbor` for a
store at the default location, `harbor:<hash of home>` for anything else. A test
run, a second installation, or a scratch store can no longer reach the real
one's credentials. The default path keeps the bare name, so nothing already in
your keychain has to move.

There is a test asserting the suite is not using the production namespace, which
is the check that would have caught this on the day encryption shipped.

**The local model probe now distinguishes empty from unparseable.** "The model
said nothing" was accurate and useless. A reply that is all reasoning and no
content, or one that ran out of tokens before answering, now says so and
suggests a non-reasoning model, because those need a different fix from a model
that cannot follow a JSON instruction.

## 0.37.2

`harbor dev preflight` said `llama3.2:3b` returns clean JSON. `harbor dev
extract` then ran fifty items against `qwen3:4b` and rejected every one. Two
commands, two answers, same machine, and nothing wrong with either piece of code
on its own.

Three files read three different environment variables: `HARBOR_LOCAL_MODEL` in
preflight, `HARBOR_LOCAL_SMALL` in the router, and a third default inside the
provider. Setting the one I told you to set changed the report and not the
behaviour.

There is now one function, `localModelFor(tier)`, and everything that needs to
know asks it. `HARBOR_LOCAL_MODEL` is the name to know and the tier-specific
variables still work.

**The default local model is `llama3.2:3b`**, not `qwen3:4b`. A reasoning model
is the wrong default for a pass whose entire job is emitting a small JSON object
from a long email: it spends its token budget thinking, returns empty content,
and takes 47 seconds per item doing it. The token ceiling also went from 1,024
to 2,048, since running out mid-thought is what produced "the model said
nothing" fifty times.

The queue fix landed, by the way: `Remaining` went from 23,705 to 127.

## 0.37.3

Fifty items "read" in zero seconds, one request in the Ollama log, and the old
model's name in the report.

The model cache was keyed on the task class, the pipeline version, and the
prompt, but not on the model. So fifty empty answers from the reasoning model
were stored, and switching models replayed all fifty from cache instantly: same
failures, same reported model, nothing actually run. An experiment that looked
like it happened.

Two changes, and both are needed.

**The configured models are part of the cache key.** A cached answer is an
answer from a particular model; change the model and it is a different question.
Slightly coarse, because the tier is not known until after routing, so this
fingerprints the configuration rather than the tier that gets used. That is the
right trade: a stale hit is silent and a recomputation is merely slow.

**An empty completion is never cached, and a cached empty is never used.** It is
not a result, it is a failure that returned 200, and storing one turns a
transient problem into a permanent one. Rows written by earlier versions are
ignored on read, so no manual cleanup is needed.
