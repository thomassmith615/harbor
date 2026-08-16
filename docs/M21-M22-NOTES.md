# M21 + M22 — Situations that survive, and an appliance that stays up

Two milestones, shipped together because they interlock in one place: making
the job conflict table symmetric changes when `pulse` is allowed to run, and
that is only safe once the overnight passes are bounded.

Everything below was run, not merely typechecked. `npm run verify` is green:
**139 tests, 0 failures**, up from 106.

---

## M21. A situation is a thing, not a fingerprint of its contents

### The bug

`threadId()` was `sha256` of the sorted member set, and `buildThreads` called
`clearThreads()` first. So a situation's identity *was* its contents: one more
text joins the crabbing weekend, the id changes, the old row is deleted, and a
different row appears in its place.

That was the second attempt. The first used a random id, which changed every
few minutes; hashing fixed the churn and left the real problem untouched.

What it actually broke, in the shipped code:

- `detectors.ts` keys `loose:${thread_id}`. An observation you dismissed came
  back under a new dedup key the moment the situation grew. From outside, that
  is Harbor nagging about something you already dealt with.
- Nothing could be renamed, resolved, or dismissed, because there was nothing
  durable to attach the decision to.
- An id printed in a digest yesterday resolved to nothing today.

### The fix

Identity moves off the contents entirely. Ids are minted once (`sit_<random>`)
and carried forward by membership overlap.

New `src/derive/situations.ts` holds the matcher. A proposal claims an existing
situation when they share **at least 2 nodes** and that overlap is **at least
half the smaller side**. Smaller, not larger, and that asymmetry is the point:
a situation that doubles is still the same weekend, while something sharing two
nodes with a set four times its size is a different thing brushing past it.

Both sides are matched greedily by descending overlap and consumed once, which
handles the three cases that occur:

| Case | Behaviour |
|---|---|
| Growth | Same id, membership updated, `last_changed_at` moves |
| Merge | Larger overlap wins the id, the other is absorbed |
| Split | Larger overlap keeps the id, the rest is genuinely new |

Tie-breaking is deterministic. A matcher whose ties break differently between
runs makes every bug in it unreproducible, which for something that silently
reassigns identity is the worst available property.

### Migration 025

Adds `state`, `title_source`, `state_changed_at`, `first_seen_at`,
`last_changed_at`, `node_digest`.

**It deletes existing `threads` and `thread_nodes` rows.** They are content
hashes carrying no state, no history, and no decisions, so there is nothing in
them worth migrating, and the next relate pass rebuilds the lot from edges that
this migration does not touch.

### Decisions worth stating

**A dismissed situation stays dismissed even as it grows.** It would be easy to
argue the opposite. But "it grew" is true of every live situation every day, and
re-raising things you already closed is the exact failure this milestone exists
to fix. Reopening is a decision and it belongs to you: `harbor situations
reopen <id>`.

**A situation nobody proposed is deleted if Harbor derived it, and kept if you
touched it.** Deleting a renamed or dismissed one is precisely how a decision
gets silently undone by the next linker version bump.

**A title you wrote outranks a title Harbor took from a calendar event**, and
survives every subsequent pass. `title_source` records which is which.

`clearThreads()` survives for exactly one caller, a deliberate full rebuild,
and is no longer part of a normal pass.

### Verified

Eight tests against the real pipeline and fixture store, plus nine unit tests on
the matcher. The load-bearing one: dismiss a situation, re-run relate, and it is
still dismissed and still absent from the list. That test could not have
compiled against the old code.

Exercised through the real CLI on a seeded store:

```
$ harbor situations dismiss sit_d56cc41a514201a7
$ harbor situations rename sit_3153d0dec2f6780b "Dentist reschedule"
$ (relate again)
  {"carried":2,"created":0,"changed":0,"merged":0,"retired":0}
$ harbor situations
  Dentist reschedule                      <- rename survived
$ harbor situations --all
  Dinner at the Kearneys  [dismissed]     <- dismissal survived
```

---

## M21b. The job conflict table was one-directional

`blockedBy()` reads `CONFLICTS[incoming]` only. It never checked whether the
*running* job had declared a conflict with the incoming one. Twenty pairs were
declared from one side only.

The damaging one: `relate` declared a conflict with `pulse`; `pulse` did not
declare one with `relate`. **Pulse runs relate internally as one of its seven
steps.** So a long relate pass did not stop the fifteen-minute pulse from
starting, and two relate passes ran concurrently over the same edge and
situation tables. On an appliance that is not a rare race, it is what happens
every time relate exceeds fifteen minutes, which on a first full store it always
does.

Same shape for `notice`, `extract`, and `reindex` against `pulse`, and for
`commit` against `derive` and `resolve`.

Fixed by computing the symmetric closure at module load rather than editing
twenty entries by hand. A hand-maintained table drifts the moment somebody adds
a task, and this one already had. `undeclaredPairs()` is exported so a test
asserts the closure is doing work, and `harbor dev conflicts` shows what was
inferred (marked `*`) versus written down.

**What this costs.** `pulse` is now genuinely refused while `extract` (4:30am)
or `notice` (5:00am) runs. That is correct and it is visible: a refused schedule
records as skipped with the blocker named, and `harbor doctor` now flags a task
that is refused repeatedly. If those windows grow long enough to matter, bound
them rather than letting the passes overlap.

---

## M22. Not filling its own disk, and not going quiet

### Backups grew without limit

`init` schedules a backup at 4am. `backup()` writes a new timestamped file and
refuses to overwrite. Nothing ever deleted one. A multi-gigabyte store backed up
nightly is a terabyte inside a year, and the first symptom is Harbor failing to
write, which is also the moment it stops being able to back itself up.

Retention is 7 daily plus 4 weekly. `selectForRemoval` is a pure function over
`(name, mtime, size)` so it can be tested without writing gigabytes, which
matters for the one function in Harbor whose worst case is unrecoverable. The
newest is never removable under any input, asserted by a fuzz over 200 trials.

Runs after the nightly backup rather than on its own schedule, because the
moment just after a successful backup is when discarding an older one is safe.
Neither prune nor rotate can fail the job.

`harbor backup --prune [--dry-run]` for doing it by hand.

### Logs grew without limit

The launchd plist redirects daemon stdout and stderr into `logs/` and nothing
rotated them. Rotation is by rename rather than truncate: the daemon holds these
open through a shell redirect, and truncating a file somebody is appending to at
an offset leaves a sparse file reporting its old size forever. The running
daemon keeps writing to the renamed inode until restart, which for a scheduled
appliance is nightly at worst.

### `history` was never scheduled

`init` wrote pulse, derive, commit, extract, notice, digest, backup. The README
says older history fills in behind you. It did not, unattended, so the store
stayed pinned to the recent window: current, and shallow, forever. Now scheduled
at 1:30am, and it deliberately still does not block derivation, so Harbor stays
answerable while a decade arrives behind it.

### iMessage copied the whole database every fifteen minutes

`snapshot()` copies `chat.db` plus its `-wal` and `-shm` sidecars in full on
every sync. Fine when a sync was something you typed; on a fifteen-minute pulse
it is ~96 full copies a day of a multi-gigabyte file that usually has not
changed at all.

The cursor now carries a fingerprint (mtime and size across all three files):
`<rowid>#<fingerprint>`. Legacy bare-rowid cursors parse to a null fingerprint,
so the first run after upgrading simply does not skip. Nothing needs resetting.

The skip is provably equivalent to running: with a non-null cursor this walk
ignores the window entirely and resumes from a row id, and row ids are
monotonic, so an unchanged file cannot contain a row above where we stopped.

The fingerprint is read *before* the copy, never after. If `chat.db` changes
mid-read, recording the older fingerprint means the next pulse reads again, and
reading twice is the cheap mistake.

### `harbor doctor` can now see the things that fail silently

- Disk headroom, sized against needing room for the store plus one more backup.
- Per-task schedule health: never ran and now overdue, last run errored, or
  refused repeatedly by a lock.

One correction made during testing: the first version warned about every
schedule that had never run, which meant a fresh `harbor init` printed eight
warnings about tasks working perfectly that simply had not come due. A
diagnostic that cries on a healthy install teaches people to skim it, and then
it is worth nothing on the day something is wrong. It now warns only once a
schedule is past its own window.

---

## Verification sequence

```bash
npm install && npm run verify          # 139 tests, 0 failures

# M21
harbor dev relate                      # carried / created / merged in the report
harbor situations                      # note an id and the "following for Nd" line
harbor situations dismiss <id>
harbor dev relate
harbor situations                      # gone
harbor situations --all                # still there, marked [dismissed]
harbor situations rename <id> "Whatever"
harbor dev relate                      # rename survived
harbor situations --new                # only what moved in the last day

# M21b
harbor dev conflicts                   # pulse should list relate*

# M22
harbor settings schedule list          # history at 01:30
harbor backup --prune --dry-run
harbor doctor                          # disk line, and quiet on a healthy store
harbor dev rotate-logs
```

---

## Not done, and not claimed

**launchd and the non-interactive keychain.** I cannot exercise a LaunchAgent in
a Linux container, so none of that is verified. It stays open in M22 and has to
be shaken out on the Mac.

**`harbor doctor` still exits 0 when it finds problems.** For a launchd health
check that should probably be non-zero, but changing it could break whatever
already calls it, so it is left alone and noted here.

**`extract` and `notice` window bounds.** Now that the closure is symmetric,
these two genuinely block pulse while they run. Currently short; worth watching
in `harbor jobs` on a full store.

---

## Applying this

Unzip and `cp -R harbor/ /path/to/your/harbor/`, then `npm run verify`.

Verified by applying this zip to a pristine extraction of the repo you sent and
running the suite: 139 tests, 0 failures.

**One caution, and it is a real one.** Your working tree had uncommitted
changes to `threads.ts`, `entities.ts`, `episodes.ts`, `purchase.ts`, and
`tools.ts`. Only `threads.ts` is in this drop, and my version sits on top of
yours.

That matters more than it sounds. `threads.ts` calls `isHandleTitle` and
`nameHandles`, which exist **only in your uncommitted `entities.ts`**. I proved
this by applying the drop to a clean `git checkout` of HEAD, where it fails to
compile:

```
src/derive/threads.ts(17,10): error TS2305:
  Module '"../store/entities.js"' has no exported member 'isHandleTitle'
```

So: apply this to your working tree, which has that code. Do not apply it to a
clean checkout of `m20` first. And commit that working tree before you copy,
because right now five files of real work exist only on your disk and this drop
overwrites one of them.
