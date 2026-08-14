# M12: one weak linker was drawing 91% of the graph

Overlay onto M11:

    cp -r harbor/. /path/to/harbor/
    cd /path/to/harbor && npm install && npm run verify
    harbor dev relate --rebuild

No migration. **Deleted: `src/derive/templates.ts`**, replaced by
`src/derive/noise.ts`.

## What the numbers said

    about_same    5457
    same_thread    312
    mentions_when   88
    ...
    a word counts as distinctive below 143 appearances in 7163 things

5,457 of 6,008 edges from the weakest linker in the set is not a discovery, it
is a threshold that lets anything through. And `harbor why` on the recruiter
email named the cause outright: its "rare words" were `devops, tarun, cheeda,
seems, lockheed, martin, native`. When `seems` is evidence, the bar is wrong.

## Four changes

**The rarity ceiling was 2% and is now 0.5%, capped at 120.** One document in
two hundred is unusual. One in fifty is vocabulary. The solo-word bar moves with
it, a sixth of the ceiling rather than a twentieth.

**One-way mail cannot be linked by a shared word.** A sender you have never
written to is broadcasting, not corresponding, and two recruiter blasts sharing
"devops" means one industry writes the same way. Detected by never having
replied plus the usual `no-reply` and `inmail-hit-reply` sender patterns.

The exclusion is deliberately narrow, and this is the part worth arguing with.
Broadcast mail is barred from *content* linking only. `shares_reference` still
works, because a confirmation code in a booking email is real evidence no matter
who sent it. `tracks` still works, because a reminder covering an appointment
notice is exactly the cross-source connection Harbor is for. What broadcast mail
may not do is get joined to something because the two share a word.

**Template detection had a bug your output exposed.** It claimed 13,294 template
items and retired 563. Your non-conversational items are 6,742, and
6,742 − 563 = 6,179, which is exactly the nodes examined. So roughly 12,700 of
those "templates" were iMessages: the grouping keys on sender plus subject
shape, an iMessage's title is the handle it came from, and an entire chat thread
collapsed into one shape. Harmless to the counts, not harmless in candidate
generation, where it dropped individual texts before they could be lifted to
their episode. Conversational streams are excluded now.

**Twenty stopwords added**, `seems` among them.

## Where the Venmo case landed

You said pairing "You paid Joey Dugery $614.00" to the apartment conversation
would be hard and that grouping it with other Venmos might be acceptable. It now
does neither: Venmo is one-way mail, so it forms no situation at all. It stays
fully searchable and still feeds `harbor purchases`, which is where a payment
belongs. If you want the apartment thread connected to what you paid him, that
is a purchase-to-conversation link through a resolved person, not a word match,
and it is a real feature rather than a threshold.

## The green bubble

Nothing to build. Sam is on Android, so his messages arrive as SMS, and SMS only
lands in `chat.db` if the Mac has Text Message Forwarding switched on. That is
iPhone Settings, Messages, Text Message Forwarding, with this Mac ticked. Turn
it on and his history flows in through the connector Harbor already has, no
outlier handling and no new source.

Worth knowing what Harbor already did without them: `gute?` on the calendar was
connected to a conversation from the night before that mentions him, via
`mentions_when`. It has the right event and the right people and no idea the
Poconos are involved, because that part was said on a phone it cannot see.

## Verified

31 tests. Two new ones cover the broadcast case: two recruiter blasts with
different subjects that must not link to each other or to a conversation about
them, and a companion test proving the exclusion stayed narrow, so the booking
code and the dentist reminder still connect.

## What I expect on your rebuild

Far fewer edges and fewer situations, possibly under ten. If it drops to zero,
0.5% overshot and the number to move is one constant in `terms.ts`. I would
rather hand you five situations you recognise than nineteen you have to audit.
