# M11: three of five situations were junk

Overlay onto M10, or replace the folder:

    cp -r harbor/. /path/to/harbor/
    cd /path/to/harbor && npm install && npm run verify
    harbor dev relate --rebuild

No migration. Nothing in your store changes. `npm run build` now sets the
executable bit on `dist/cli/main.js`, so `npm link` stops producing "Permission
denied".

## What was wrong, in the order it mattered

**Contacts were graph nodes.** A contact card is a fact about who someone is,
not something that happened. Its `occurred_at` is when the card was written,
which is why `Myles Menowitz` read as a two-source situation spanning three
days. Contacts still do the most important job in the store, turning addresses
and phone numbers into people; they are simply not endpoints.

**Recurring notifications chained into fake situations.** Twenty Venmo receipts
for one weekly transaction was the top-ranked situation on the real run. Every
statement in it was true and the whole was worthless. The store already had this
idea one level down: a confirmation code in forty items is a template rather
than an identifier. The same reasoning applies to items. Strip the numbers out
of a subject, group by sender, and anything recurring five times or more is a
notification. They stay searchable and still feed purchases; they stop being
nodes in a graph whose job is noticing that two *different* things are one
thing.

**The solo-word bar was a constant while the ceiling scaled.** Hardcoded at 3
against a rarity ceiling that reaches 500, so anything appearing between 4 and
500 times needed a partner word. "Wildwood" appeared in 19 things out of 40,000
and was rejected, which is exactly the shore-town question. Now a twentieth of
the ceiling, floored at 3.

**Document frequency double-counted conversations.** A word was counted once per
message *and* once per episode, so an eighty-message thread saying "steak" once
per message counted as eighty-one documents. That inflation is why "restaurant"
looked like it appeared in 121 things and why so little cleared the bar.
Conversational messages now leave the corpus for the same reason they left the
graph: their episode stands for them. Expect noticeably more to be distinctive.

**Hostnames were words.** `amazonaws` was among the rarest-looking terms in your
store, because it is in the tracking pixel at the bottom of thousands of
marketing emails. Links are stripped before tokenizing. This does lose some real
signal, `toasttab` among it: a merchant that matters is in the sender or the
subject too, and a false edge between unrelated receipts is worse than a missing
one between related receipts.

**A situation now needs a spine.** At least one event, task, or conversation.
Mail is the connective tissue of a situation and rarely its centre; without this,
any pile of receipts sharing a rare word qualified.

## Output that does not eat your scrollback

`harbor people cards` printed 421 records and `harbor why` printed every
candidate, which is how you lost the earlier output you wanted to send me. Both
now stop at 25 with a footer saying what was withheld, and both take `-n <count>`
and `--all`. Two new filters for the cases you actually wanted:

    harbor people cards --stranded    only cards with nothing to anchor to
    harbor why <id> --linked          only what an edge was drawn to

A truncated list that does not admit it was truncated is a list that lies about
what Harbor holds, so the footer is not optional.

## Verified

29 tests. Five are new and each reproduces one of the failures above from your
run, including a contact card that must not enter the graph and six identical
payment notifications that must not chain.

The threshold bug is pinned as a pure function rather than end to end, because
proving it needs a forty-thousand-document store and the mistake is arithmetic:
`soloCeilingFor(500)` must be 25 and not 3.

## Two things from your run I did not fix

**Your self entity holds five identifiers**, including `leanbrizko@gmail.com`
and a second phone number. If either is not yours, `harbor people unlink
<address>` splits it. The merge path treats any address seen as an outbound
author as definitively you, which is too strong if a forwarded message ever put
someone else in a From header. Tell me if it is wrong and I will tighten it.

**`harbor people show thomas smith` finds a Google Docs notification** rather
than you, because your self entity's display name is an email address. Small,
and it will annoy you every time.

## Next

Encryption at rest, then Gmail and IMAP attachments, which is where most of your
receipts actually are.
