# M22: an interface you can actually run Harbor from

    cp -R ~/Downloads/harbor/ .
    npm install && npm run verify
    ./run.sh

No migration. Nothing deleted.

Three views instead of two: **Ask**, **Sources**, **Run**. The daemon serves
them at `http://127.0.0.1:8484`, same as before.

## The page is files now, not a string

M20 compiled the page into `src/surfaces/app.ts` as a template literal, and the
argument was sound: one repository, one build, no deploy, no version skew. The
previous front end was a separate project, fell six milestones behind the API it
talked to, and was shelved.

That argument is about shipping in the same package. It is not about being a
string, and the string charged for itself in a currency that got expensive as
the page grew. Every regex backslash has to be doubled or it silently vanishes.
A backtick in a pattern ends the file. Both cost real builds in M20, and M20's
own notes record the second one catching me a third time when a `\u2022` in a
patch became a literal bullet and the insertion did nothing while the build
stayed green.

`src/surfaces/ui/` is now `index.html`, `app.css` and `app.js`. `scripts/copy-ui.mjs`
copies the directory into `dist/surfaces/ui` as `postbuild`, so `npm run build`,
`npm test` and `npm run verify` all get it and there is no second command to
remember. `src/surfaces/app.ts` is nine lines that resolve that directory from
`import.meta.url`, which is correct whether Harbor started from the repository,
from a global install, or from launchd with a working directory of `/`.

Every property that mattered is intact. One repository, one `npm run build`, one
thing to copy, and nothing that can be a different version from the daemon
serving it.

There is no bundler and there should not be one. There is nothing to transpile
and nothing worth minifying for 48 KB over a home network, and a build tool here
would be the second thing that can fall out of sync.

## One endpoint

The page reads `/overview` and calls `/ask`. That is the whole API surface it
knows.

`/overview` is `src/surfaces/setup.ts`, which already existed for exactly this
reason: nearly every screen is a view over "am I set up" and "what is wrong
right now". It returns sources with their streams and item counts, what is
connectable and why not, the job list, what is running, task availability,
problems, and the store totals.

It composes functions the CLI already calls and computes nothing. That is the
rule that keeps a third surface cheap, and the one to defend: the moment logic
lands in a handler, the CLI and the API start disagreeing about what Harbor
does.

The alternative was polling six endpoints, which gives six instants. A screen
assembled that way contradicts itself for a second every time a job finishes:
sources from before the sync, job list from after.

## Persistence across a refresh was already solved

Requirement: operation status survives a browser refresh.

Jobs have lived in SQLite since M14. A refresh is a fresh `/overview`, which
reports the same running job with the same progress, because none of it was ever
in the page. There is no client state to persist and nothing was added to make
this work. The only reason it did not appear to work before is that the page had
nowhere to show it.

Chat is the opposite and deliberately so. A conversation id lives in a variable
and dies with the tab. Conversations are stored server side and `harbor ask`
reads them; the page starting fresh is a choice, not a gap.

## The lamp strip

A row of source lamps under the header, on every view, one per connected
account. Colour is freshness, computed from the newest `lastSyncAt` across that
account's streams: green under six hours, amber past that, red past three days,
blue and breathing while a sync is in flight, grey for a source that has never
run.

It is the answer to "is Harbor healthy and current" without navigating
anywhere, which was the requirement, and it is one line of information rather
than a dashboard. Tapping one goes to Sources.

Everything else stays quiet so this can be the thing you look at.

## Four operations

`JOB_TASKS` has sixteen entries. Most of them are pipeline stages that exist for
working on Harbor, and putting sixteen buttons on a screen is how you get a
screen nobody reads.

| Button | Task | Why it earns a button |
| --- | --- | --- |
| Sync | `pulse` | Fetch, then classify, derive, resolve, relate, commit, signals. The daily one |
| Fill in history | `history` | Only visits streams that still owe one, so it is cheap to press and "finished" is a real state |
| Rebuild links | `relate` | Recompute the graph and the situations. The one to press when an answer looks wrong |
| Back up | `backup` | Encrypted copy, before doing anything you might regret |

Availability and blocking come from `taskAvailability`, which already existed
and already said what a client may start right now and what is stopping it. A
blocked button says what it is waiting on rather than failing after a tap.
Tapping a running operation stops it.

`pulse` is on a fifteen minute schedule already, so Sync is a nudge rather than
the mechanism. Nothing here is the only way anything happens.

## Connecting a source

All four flows were already in the API and none of them had a way in that was
not a terminal. The sheets are forms over endpoints that already existed.

Mail is two steps on purpose, and that was already the API's shape: discover the
server, show which host is about to receive a password, and only then ask for
one. Nobody should type a credential into a form that has not said where it is
going.

Google says plainly that it has to be finished on the Mac. Google only redirects
to loopback, so a phone cannot complete that flow, and the honest thing is to
say so in the sheet rather than let somebody discover it halfway through.

Unavailable sources are visible and disabled with the reason in place of the
description: iMessage needs the Mac holding the messages and Full Disk Access,
Google needs a client id in `~/.harbor/.env`. Hiding them means somebody asks
why Harbor cannot read their texts.

## A caching bug that would have looked like the upgrade failing

`static.ts` served everything except `index.html` as
`public, max-age=31536000, immutable`. That is correct for content-hashed
bundles. The built-in interface is `app.js` and `app.css` with no hash in the
name, so any phone that opened Harbor once would keep the old page after every
upgrade for a year, with no way out but clearing site data.

Now `no-cache` on everything. These are a few kilobytes over a home network and
revalidating them costs nothing worth that class of bug.

## Tests

176 pass, up from 174, and the two new suites are about the two ways a page made
of files fails silently.

**Endpoints are extracted from `app.js` and checked against `API_PREFIXES`.**
Not a list written down beside the page, because a list would go stale exactly
when it mattered. A call to a route the API does not serve now fails the build
rather than a phone.

The lookbehind in that regex earns its comment: in `"/jobs/" + id + "/cancel"`
only `/jobs` is a route, and without dropping the tail of a concatenated path
the test fails on correct code.

**The files have to reach `dist`.** If `copy-ui.mjs` is ever dropped, the daemon
answers the root with a 404 and the only symptom is a blank page.

The markdown renderer tests carry over unchanged, still lifted out by source
markers and run for real, still four of them about what must not happen. They
got easier to read: the patterns are now written the way patterns are written.

**`imports.test.ts` skips `surfaces/ui`.** It walks `dist` and imports every
module, which found the new page immediately and failed on `localStorage is not
defined`. Correct behaviour from a test doing its job. Browser JavaScript is not
a module of the daemon and there is no version of importing it under Node that
means anything.

## Two bugs the page had before anybody saw it

Found by rendering it against a fixture rather than by reading it.

`body.append(el("label", ...)).htmlFor = id` throws. `Element.append` returns
undefined. Every connect sheet with a text field would have died on open, and
reading that line will not tell you so.

The SSE parser was verified against frames split mid-JSON across chunk
boundaries, which is what a real socket does and what a parser that splits on
`\n\n` per chunk gets wrong. It buffers the tail, which is right, but "it looks
right" is not the same as having watched it.

## Known, and not being fixed here

`scrollIntoView` sits outside the `try` in the submit handler, so if it ever
threw, `asking` would stay true and the composer would stay disabled until a
reload. Every browser implements it. Worth knowing, not worth a guard.

`src/cli/main.ts` is still one file of about 4,700 lines.
