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

## 0.38.1

Every new rule worked and the report barely changed, because a projection
outlives the reasoning that produced it.

Three rules changed in 0.38.0: receipts from consumer mail accounts stopped
counting, brokerage and card activity became transfers, and unpriced line items
were dropped. All three applied to new extractions and none of them to rows
already in the table. A rule that says "this is not a purchase" writes nothing,
and writing nothing cannot overwrite anything.

So an invoice scam and $1,650 of brokerage transfers survived two full passes
under rules that had already rejected them, and were re-rejected for free on
every pass by a predicate whose verdict went nowhere.

Rows written under an older schema version are removed at the start of a pass,
and an item that no longer yields a purchase loses the one it used to have,
whether it was rejected by the free predicate or by verification. A report now
describes one set of rules rather than a mixture of two.

Extraction also gets a larger token budget. "No JSON object in the response"
beginning with a valid `{"purchase":{"merchant":"American Airlines"...` is not a
model failing to follow instructions, it is a reply that stopped mid-object.

## 0.38.2

The purge worked and the re-read did not. Thirty-nine purchases removed, none
read again, and three consecutive passes reporting the same thirty-three
failures in zero seconds each.

**Deleting a projection left the item marked as done.** The pass asks for items
whose `projection_version` is not current, and every one of those thirty-nine
still looked processed. Dropping a row now puts its item back in the queue,
which is the only thing that makes the row's deletion mean anything.

**A cached answer that fails verification was replayed forever.** The thirty-three
rejections were cache hits: the same unparseable reply, returned instantly, on
every pass. Re-running could never have changed the outcome. An answer that did
not survive parsing or checking is now forgotten, so a retry is a retry. Same
principle as refusing to cache an empty completion, one step later.

Both faults share a shape with the one before them: a decision was recorded in
one place and the thing that acts on it looked somewhere else.

## 0.38.3

Seventeen purchases extracted, three in the report.

**The stated date was trusted absolutely, and small models guess years.** A June
receipt came back dated 2024, which is not wrong by a little: it is outside
every window anything asks about, so the purchase existed, was correct in every
other respect, and was invisible.

A receipt arrives when the purchase happens, near enough. The stated date is
used when it is close to the message that carried it and the message's own date
otherwise. Both are facts; the arrival date is the one that cannot be
hallucinated. Asymmetric, because a receipt can plausibly arrive a few days
after a purchase and cannot plausibly arrive months before it.

**A purchase with no merchant is rejected.** A total with nowhere to attach
cannot be grouped, deduplicated, or asked about, and it showed up in the report
as `unknown 27.23`, which is worse than absent because it looks like a finding.

Both of these are the same class as the errors above them: something recorded in
one place and read somewhere it could not be checked against. The date now gets
checked against the only other date in the room.

## 0.38.4

**The date guard shipped without bumping the schema version.** So it applied to
new receipts only, and the seventeen purchases already filed under hallucinated
years stayed exactly where they were: correct in every respect except the one
that made them findable, and marked as processed so nothing would re-read them.

That is the second time a rule changed without the version that invalidates old
rows. `PURCHASE_SCHEMA_VERSION` now carries a comment saying what it is for,
because it is not a description of the data shape, it is the only mechanism that
makes a rule change apply to what already exists.

**Extraction gives up after three attempts.** Fourteen items failed on every
pass, several of them marketing pages that will never contain a total, at
roughly six seconds each. The queue never drained and every future run paid the
same cost for the same answer.

Three rather than one, because the model is not deterministic and a retry
genuinely does succeed sometimes: a real run recovered twelve items on a second
attempt. Three failures is a message that cannot be read rather than a call that
went badly.

The attempt count is a projection like any other, so it is versioned the same
way: when the rules change, the count is dropped with everything else and an
item that used to be unreadable gets another chance.

## 0.39.0

`store+75632214210@t.shopifyemail.com` looked like a solid envelope and is
nothing of the kind. Every Shopify store on earth sends from that domain, a real
boutique and a dropship front alike, and the same is true of SendGrid, Mailgun,
Klaviyo, Mailchimp, and most of what a small merchant uses.

So the sender check was asking the wrong question. "Is this a real sending
domain" is answerable and nearly useless; "is this a merchant you have a
relationship with" is the one that matters, and for a shared platform the
envelope carries no evidence at all. A brand-name check against
`t.shopifyemail.com` cannot fail and cannot pass. It does not apply.

**Corroboration is the evidence that was missing.** A real merchant leaves a
trail: an order confirmation, then a shipping notice, then a delivery notice,
often a review request weeks later, and for anything you chose deliberately,
usually a reply or a conversation. A single email claiming a seven-hundred-dollar
phone from a sender who has never written before or since is the shape of a scam
or a mistake.

Counted rather than judged: two or more messages from that sender, or any
message you sent them, is enough. Below that, a purchase over $150 from a shared
platform is recorded and kept out of the spending total until you say otherwise.
That is the same stance the fact layer already takes, and the reason the
threshold exists is that a rule which doubts a twelve-dollar lunch is a rule
nobody reads.

`harbor purchases merchants` says how many are being held back, because a total
that quietly omits a $749 purchase misleads exactly as much as one that quietly
includes it. The difference is only which way the error runs.
