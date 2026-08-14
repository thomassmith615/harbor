# M10: ninety-two commands become thirty-one

Overlay onto the M9 folder, or replace it:

    cp -r harbor/. /path/to/harbor/
    cd /path/to/harbor && npm install && npm run verify

No migration. Nothing in your store changes.

**Deleted: `src/actions/`.** See below.

## What moved

Nothing was renamed for the sake of it. Three rules:

**One front door per intention.** A person has about six: set it up, connect
something, bring it up to date, ask it something, see what it noticed, check it
is healthy.

**Nouns take an optional id.** `commitments` and `commitment` were one verb
wearing two hats, and so were conversations, digests, facts, purchases, and
people. Listing is what you want nine times out of ten, so it stays the default:

    harbor commitments              was: harbor commitments
    harbor commitments show <id>    was: harbor commitment <id>
    harbor purchases merchants      was: harbor spend
    harbor digest history           was: harbor digests
    harbor facts add "..."          was: harbor remember "..."
    harbor facts confirm <id>       was: harbor confirm <id>
    harbor people show <name>       was: harbor person <name>
    harbor people merge <a> <b>     was: harbor merge <a> <b>
    harbor people cards             was: harbor contacts
    harbor conversations show <id>  was: harbor conversation <id>

**Rarely-touched behaviour lives in one place.** `schedule`, `policy`,
`detectors`, `weight`, `router`, `cost`, `interest`, `secrets`, and `audit` each
owned a top-level verb and are all answers to "how does Harbor behave". They are
now `harbor settings <thing>`, and each lists by default.

**Diagnostics admit what they are.** `calendars`, `imessage`, `attachments`,
`brief`, `chats`, `chat`, `mcp`, `install-service`, `problems`, and `run` joined
the twelve pipeline stages under `harbor dev`.

Every hint printed anywhere in the codebase was rewritten to match, including
the catalog the model reads when someone asks Harbor how to do something. That
catalog is the thing most likely to drift, because nothing fails when it does.

## What was deleted

`src/actions/`, and its command group, its HTTP routes, its MCP tool, and the
Google OAuth write scopes it was the only reason to request.

Write actions were described as shipped in one place in the README and "not here
yet" in another, which usually means nobody has used them. They were a real
subsystem (propose, approve, execute, with an audit trail) sitting unfinished in
a product whose one goal is reading many sources into one coherent picture.
Keeping them meant every future change had to keep them compiling.

The consequence worth knowing: **Harbor now asks Google for read-only scopes.**
If you had authorized it before, nothing breaks; it simply stops requesting
permission to change your calendar. If write actions come back it should be a
decision, not an inheritance.

## Verified

`npm run verify`: typecheck, build, 23 tests. Plus every command group invoked
against a fresh store. `harbor --help` now lists 31 things instead of 92.

## Next

Two candidates, and I would take the first.

**`harbor connect`.** The remaining rough edge in the new-user path is that
`auth` is still three source-specific flows a person has to know about. One
interactive walkthrough that detects the platform, offers what is available, and
runs the health check afterwards would make the path genuinely `init`,
`connect`, `update`.

**Splitting `src/cli/main.ts`.** Still one file of about 3,900 lines. The
surface it registers is now the right shape; the file is not, and it is the
thing that makes every future hand widen it.

Encryption at rest is M11 and should not slide again.
