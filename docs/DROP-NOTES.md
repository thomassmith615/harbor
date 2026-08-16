# One dead source was stopping every other source

166 tests, 0 failures.

## What was actually happening

```
j_b2eaaab833af4487  onboard  failed
             error: No credential strategy for source type files
j_cc3691a0912b44fb  pulse    failed
             error: No credential strategy for source type files
```

Two faults, and the second is much worse than the first.

**`credentialFor` ran before the connector filter.** The `files` connector was
removed from the registry when the card work was shelved; its account row stayed
in the store. So an account with nothing to sync was still asked to produce a
credential, and threw.

**Nothing caught it.** No try in any of the three sync loops. A single throwing
account aborted the entire loop, so **every account after it never synced at
all**. Mail, calendars, reminders, and messages were all quietly not updating
because of one dead source, with nothing to show for it but a line of job error
you would only see if you looked at `harbor jobs`.

That is why `harbor update` has not been bringing your texts in. Coverage still
reads `message ... -> Sat, Aug 15 6:13 PM`.

## Fixed

**Connectors are checked before credentials.** An account whose source type has
no registered connector returns no work and is skipped. Inert, not broken.

**All three sync loops isolate per account.** Job runner, scheduler, and CLI. A
failure is named and the loop continues, and the failure is reported in the job
note rather than swallowed:

```
1,204 new or changed across 6 streams; 1 source(s) failed: inbox (files): ...
```

Reporting success on a pass where a source never ran is how a store silently
stops updating, so a partial sync now says it was partial.

## Your data stays

I did not remove the `files` account and you should not either. Those 742
`transaction` items came from it, and Coyote Crossing, Wards Berry Farm, Cafe
Neos, Morgan's Pier, Gypsy Saloon and Curb Phl Taxi are all transactions
anchoring your best cross-source situations. Deleting the account risks taking
them with it. An account with no connector is now simply inert and keeps
everything it brought in.

If you do want Capital One CSVs flowing again later, that is a connector to
re-add, not an account to recreate.

## Verified

A test that asserts `connectorsFor("files")` is genuinely empty (so it fails
loudly rather than passing quietly if a files connector is ever re-added), then
that syncing such an account returns no work instead of throwing.

Then on a real store with the orphaned account present: every account attempted,
`files threw: false`, and the only throws were network ones this container
cannot avoid, which is exactly the case the new try/catch exists to contain.

## The reachability question is settled

```
   7767 Isabella Forté    in   348 conversations
   2816 Luca D            in   415 conversations
   2047 Joey Dugery       in   447 conversations
```

The join is healthy. The earlier UI answer was not a data gap, so whatever went
wrong there is in retrieval or in how the model used the tool. Worth re-testing
once your sync is actually current, since you have been asking questions of a
store that stopped ingesting.

If it still misbehaves, `harbor ask --new --trace "..."` prints every tool call
and its arguments, which is what I would need next.
