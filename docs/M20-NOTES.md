# M20: reachable from your phone

    cp -R ~/Downloads/harbor/ .
    npm install && npm run verify
    harbor --version
    harbor daemon

Then on the Mac, in another terminal:

    harbor device code

And on the phone, on the same network: `http://<mac-ip>:8484`. Type the code.

No migration.

## Harbor serves its own interface

A single page compiled into the daemon. No second repository, no build step, no
deploy, no CORS, no mixed content, no second certificate, and nothing to
remember to rebuild.

That last point is the whole argument. The previous front end was a separate
project, fell six milestones behind the API it talked to, and was shelved. A
page that ships inside the binary has no version of its own to be wrong.

It is deliberately small: ask, read the digest, see what Harbor holds. The
mandate says the current UI is a development surface and warns against polishing
it at the expense of the system underneath, so this is the version that works
when a real client does not exist yet, and stays as the version that works when
a real client is broken.

It is served before the token check, because it is not secret and because a
browser needs the page in order to have somewhere to type the pairing code.
Everything behind it still needs a token: `/status` without one returns 401,
verified.

## Why not GitHub Pages

Static hosting gives you a front end. What is hard is reachability, and they are
different problems.

A page served from a public host cannot talk to `http://10.0.0.54`: mixed
content blocks it, a self-signed certificate blocks it, and browsers now block
public origins from reaching private address ranges regardless. Working around
all three means building a tunnel by hand, badly. And static hosting only helps
if the backend is public, which for a mail archive is the thing the encryption
milestone existed to prevent.

Getting to it from outside the house is a network problem. Tailscale is the
answer that fits the mandate: a private network between your own devices, no
ports forwarded, nothing exposed, real HTTPS for the machine name. Cloudflare
Tunnel works and terminates your traffic at a third party. Port forwarding does
not deserve a sentence.

## Verified end to end

Not just typechecked. A daemon was started, the page fetched (200, 8.8 KB),
`/status` refused without a token (401), a code issued with `harbor device
code`, redeemed at `/pair` for a token, and both endpoints the page uses
answered correctly with it.

That caught the one real bug: the page told you to run `harbor device pair`,
which creates a token for a named device rather than a code a browser can
redeem. Someone following it would have got an error with no way to know which
half was wrong. There is a test asserting the instructions name a command that
exists.

## The laptop question

With the lid closed, macOS sleeps, and power makes no difference; it is the lid.
Lid open with sleep set to never works, and display sleep on its own timer keeps
the screen dark.

Two things bite after a reboot: the LaunchAgent starts at login rather than at
boot, and the keychain unlocks at login, so before that the store key is
unreachable and Harbor could not open the database anyway.

This is the argument for the closet machine the mandate describes. Nothing here
assumes a particular host, and moving it is a copy of `~/.harbor` plus a
keychain entry.

## 0.41.1

Answers arrived as literal asterisks. Models write markdown whether or not you
ask them to, and the page was setting `textContent`.

It renders the subset that actually turns up: emphasis, inline code, headings,
bullets, numbered lists, links. Roughly sixty lines, no dependency.

**Escaping runs first and unconditionally, and that ordering is the whole
security argument.** The text being rendered is a model's output over the user's
own mail, so it can contain anything the mail contained: a script tag from a
marketing email, an `img` with an `onerror` handler. Escape everything, then add
back only the tags this function chose, and there is no path from source text to
live markup. Links are restricted to http and https for the same reason, since a
`javascript:` URL in an answer would otherwise be one tap from running.

Seven tests, four of them about what must not happen. The renderer is lifted out
of the page by source markers and run for real, which is crude and beats
trusting a function that turns model output into markup on the basis of having
read it.

Two things that each cost a build, worth recording:

**Regex backslashes inside a template literal need doubling.** `\s` in the page
source becomes `s` in the served JavaScript, so every regex in the renderer was
silently malformed until each backslash was escaped.

**A backtick in the code-span pattern closes the template literal.** Obvious in
hindsight, invisible until the file stops parsing.

Both are the price of compiling a page into a TypeScript string, and both are
caught by the build. The alternative is a second build step and a second thing
to keep in sync, which is what M20 exists to avoid.

## Footnote: the daemon binds to localhost

`harbor daemon` listens on `127.0.0.1`, so a phone on the same network cannot
reach it until you say `harbor daemon --host 0.0.0.0`. The default is right: a
fresh Harbor is not on the network until somebody deliberately puts it there.
The command block should have said so.

Worth knowing when you do. The token is then the only thing protecting the store
from anything else on the wifi, and it crosses the network in the clear over
HTTP. Reasonable on a home network, and the reason Tailscale is the answer for
anything beyond one.

## 0.41.2

Three things from using it, and the two that mattered had the same cause.

**"Who have I contacted recently" had no tool behind it.** There was no way to
list correspondents, so the model fell back to text search and answered from
whatever happened to match, which reads as Harbor not knowing its own contacts.
It is a group-by over the entity links, which is the one question this store is
unusually well equipped to answer: 1,403 resolved people and 31,000 links.
`people` now does it.

**"What did Joey ask me recently" said there were no messages, and there are
thousands.** This one was not a missing capability. `conversations` already
accepts a `person` id and `find_person` already resolves a name to one; nothing
told the model to connect them, and `find_person` mentioned only `search`.

The reason it fails silently is worth writing down, because it will keep
catching people: **an iMessage transcript never contains the sender's name.**
The title is a phone number and the words are just words. So searching for
"Joey" over conversations returns nothing, and nothing about that result says
"you asked the wrong way". The model concluded the messages were absent, which
is the correct inference from what it could see.

Both tool descriptions now say so directly, including the instruction never to
conclude a person's messages are missing without having tried their entity id.

Worth noting what this is not: a retrieval failure. The links were there, the
filter worked, and the answer was wrong anyway because the guidance pointed at
the wrong door. Tool descriptions are part of the system, not documentation of
it.

**Tables render.** Models reach for one whenever they are asked to compare
anything, and a pipe grid wraps into nonsense at 380px. Recognised by the
separator row, which is the only unambiguous marker: a line containing a pipe
could be prose, a line of pipes and dashes could not. There is a test for
exactly that false positive, since `harbor purchases | head` inside backticks
must stay prose.

And the template-literal trap caught me a third time: Python turned `\u2022` in
my patch into a literal bullet, so the insertion silently did nothing and the
build stayed green. The test failing is the only reason I noticed.

## 0.41.3

"Who have I texted today" answered with a table of phone numbers.

I fixed this in M13 and fixed the wrong thing. Handle resolution was written for
situation titles and stayed private to that file, so `harbor situations` printed
"Isabella Forté" while the layer a person actually reads printed
`+13392047146`. Harbor had 1,403 resolved people and 2,763 identifiers and the
code that knew the answer was never called.

Moved into the entity store, where any layer can reach it, and applied to the
three places a name reaches a model:

- **`with`**, the participant list on a conversation, which was the raw handles
  and is what the answer was built from.
- **Speaker labels in a transcript**, so "who said what" is a name.
- **Situation and `related` titles**, resolved once in the function that renders
  a node rather than by each caller remembering to ask.

Transcripts are resolved at read time rather than rewritten at derive time,
deliberately. A name is derived data and resolution improves; a transcript
rewritten at ingest would be frozen with whatever Harbor knew that day, and a
later merge or rename would never reach it.

Two things it will not do. An unknown number stays a number, because a handle
with nobody behind it is still information and inventing a name would be worse
than showing digits. And only a label at the start of a line is a speaker, so
"call me on +1555..." inside a message stays as written.

Seven tests, covering both directions.

## 0.41.4

"Who have I texted recently" still answered with a column of phone numbers, and
0.41.3 would not have fixed it either.

An entity created from a message is named after the handle it came from, because
that is all a message carries. The real name arrives later from a contact card
and lands as a `name` identifier on the same entity, not as its display name. So
`display_name` is a phone number for most of the people somebody texts, and
every surface reading that column got digits.

`nameForHandle` gave up when the display name looked like a handle, which is
precisely the entity that most needs naming, with the contact card one join
away. It now falls through to the entity's best `name` identifier, and
`recentCorrespondents` resolves through the same path rather than reading the
column directly.

Worth stating as a rule, since this is the third surface to get it wrong:
**`entities.display_name` is not the name to show.** It is whatever named the
entity first. Anything a person reads should go through the resolution, and
anything that reads the column is a bug waiting for somebody to notice.
