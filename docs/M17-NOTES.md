# M17: a spending report where half the money never moved

Overlay onto M16:

    cp -r ~/Downloads/harbor/. ~/Documents/repos/harbor/
    cd ~/Documents/repos/harbor
    npm install && npm run verify
    harbor dev extract

No migration. The purchase schema version moved to 2, so every email is
reconsidered and the old purchases are replaced as extraction works through
them. Run `harbor dev extract` a few times, or leave the daemon to it.

## What the first real report said

    4885.93 USD across 26 merchants
      1649.88  Robinhood        2 purchases
       675.99  PayPal           1 purchase
       514.98  GEEKSQUAD        2 purchases
       249.99  GEEK SQUAD       1 purchase
       411.98  PGA TOUR Superstore  2 purchases

Four separate faults in five lines.

**$2,600 of $4,885 was money moving, not money spent.** Brokerage transfers,
card payments, peer-to-peer sends. Every one real, none of them spending, and
together they made every other number in the report meaningless.

Transfers now have their own projection type. Recorded rather than discarded,
because "$1,522 to Robinhood on June 15" is worth keeping, and visible with
`harbor purchases --transfers`. `harbor purchases` is spending.

**GEEKSQUAD and PayPal were invoice scams.** A PDF attached to a message from a
consumer mail account, claiming a charge that does not exist, hoping the
recipient calls the number to dispute it. The extraction did its job perfectly
and read exactly what the document said.

The defence is about the envelope, not the content, because the content is the
part an attacker controls and writes convincingly. A receipt from gmail.com is
not a receipt, and a display name claiming a brand its domain does not is either
a scam or a forward. Both run in the free predicate, before any model is called.

**One pizza place counted three times.** `The Tomato Shack - Conshohocken`,
`Tomato Shack - Conshohocken`, and `The Tomato Shack - Conshohocke`, the last
truncated by a column width. `GEEKSQUAD` and `GEEK SQUAD` likewise. Merchants
are grouped by a normalised key now, and the displayed name is the longest
variant, since truncation is the usual cause of variance.

The prefix rule has a twelve-character floor on purpose: it must join
`...Conshohocke` to `...Conshohocken` without joining `Uber` to `Uber Eats`,
which are different businesses sharing a stem.

**One launch monitor bought twice.** $199.99 at midnight and $211.99 at nine the
next morning: an order confirmation and then a receipt with tax. Deduplicated
within 36 hours when totals are within a quarter of each other, keeping the
later and richer record. Applied to the CLI and to what the model sees, because
`ask` should not have to work out that two rows are one purchase.

## Also

**Line items with no price are dropped** rather than stored as 0.00. Real output
had "Cheesesteak 0.00", "Uber Delivery 0.00", and one item named `...`. A zero
printed beside a total reads as free.

**Invalid JSON escapes are repaired.** `\$` inside a string is a lexical fault
with no effect on meaning, so dropping the backslash recovers the text and
cannot invent a value, which remains the line this does not cross. Genuinely
malformed JSON is still reported rather than guessed at.

## Verified

69 tests, eleven new, every one of them a line from that report: the scam
senders by their real addresses, the three spellings of the pizza place, Uber
against Uber Eats, and the transfer list.

## Where this leaves the pantry idea

The `ask` tool for purchases already existed and had nothing trustworthy to
read. It does now. `harbor ask "what did I spend on takeout last month"` is the
thing to try, and recurring-purchase detection ("you buy this every three weeks
and it has been five") is the next step rather than a rewrite.
