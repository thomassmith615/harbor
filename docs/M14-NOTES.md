# M14: the store is encrypted, and four leftovers

Replace the folder rather than overlaying: the database driver changed and a
stale `node_modules` will fight you.

    mv harbor harbor-old
    unzip harbor-m14.zip && cd harbor
    npm install && npm run verify
    harbor dev relate --rebuild

Nothing in your store changes until you ask for it. Encryption is opt-in and
one command.

## Encryption at rest

Deferred three times, warned about by `doctor` on every run since M4, and the
largest gap between the mandate and the code: 264 MB holding a decade of message
bodies and every contact you have, in a plain file.

    harbor settings encryption            what the situation is
    harbor settings encryption --enable   encrypt it, once

**Read this part before running it.** The key goes in the keychain, the command
prints it once, and there is no recovery. A recoverable encryption key is a
second copy of the key, so it is not a feature that was skipped. Write it down
somewhere that is not this machine, then back up.

`better-sqlite3` is replaced by `better-sqlite3-multiple-ciphers`, the same
library with a cipher layer compiled in, with prebuilds for macOS. Verified end
to end before any of it was written and again by the test suite: rekey in place,
then full text search and the sqlite-vec index both still work, and the file
returns SQLITE_NOTADB without the key.

Rekey rather than export, because exporting means a second complete plaintext
copy of the store on disk for the duration, which is a strange way to secure a
file. A copy is still taken before the rewrite and deleted only after the result
has been reopened and read, and a failure puts the original back.

What it buys, precisely: the file is unreadable if it is taken. It is fully
readable while Harbor is running, because the daemon holds the key. That is the
right trade for a machine in a closet and it is not a claim to anything more.

## The four leftovers

**Shipping lifecycles are one order.** "Order 295403 confirmed", "on the way",
"out for delivery", "delivered" genuinely share an order number, so
`shares_reference` was right to join them, and thirteen of them is still one
purchase rather than a situation. Several one-way mails count as one thing.

**A reminder covers the nearest occasion.** "HAIRCUT 7:30PM" matched six
conversations and "wash sheets" five, because a short generic reminder finds its
own words in every conversation within three weeks. Beyond seven days it is a
different haircut.

**Titles work now, and the cause was sillier than expected.** An episode's title
had the message count baked into it, so "+16103902494" was a recognisable phone
number and "+16103902494 (15 messages)" was not. Raw handles therefore beat real
subject lines in the naming contest, which is why you saw a situation named
after a phone number that also contained four "Re: Vehicle Registration" emails,
and why every conversation line printed its count twice. The count is gone from
the title, group-chat handle lists are recognised, and handles resolve to names.

**Joey Dugery is two entities**, `+16103902494` with 2,038 items and
`jdugery16@gmail.com` with 3. That is entity resolution working as designed: an
address and a phone number are separate anchors and nothing links them, so it
under-merges rather than guessing. `harbor people merge` fixes it permanently.
I am not making name-matching link anchors automatically; silently welding two
people together produces confident, well-sourced, wrong answers.

## Verified

38 tests. Four are new and cover the encryption claim itself on a real file:
plaintext gone, unreadable without the key, full text search still working with
it, and the pre-encryption copy not left behind.

## Next

Gmail and IMAP attachments, which is where most of your receipts actually are.

## 0.35.1

The iMessage connector opened `chat.db` with its own direct `better-sqlite3`
import, which kept the old package alive as an invisible dependency until it was
removed from `package.json` and nothing would load. It now uses the same driver
as the store.

Worth a note rather than a silent patch: shipping two native SQLite modules to
read two SQLite files means two prebuild matrices to keep working on a machine
meant to run unattended for months. `chat.db` is Apple's file and unencrypted,
so the cipher build reads it exactly as the plain one did. One driver.

The reason `npm run verify` did not catch this: nothing in the test suite touches
the iMessage connector, because it needs a real `chat.db`. The failure surfaced
on the first import instead, which is the least useful place for it.

## 0.35.2

`harbor dev relate --rebuild` on an unencrypted store failed with "file is not a
database".

The cause: something in the keychain answered to the store-key lookup, so Harbor
applied a key to a plaintext database. That does not silently do nothing. The
driver rejects the file as SQLITE_NOTADB, and the error points nowhere near the
cause.

The fix is not a better keychain lookup. **The file decides whether it needs a
key**, read from its own sixteen-byte header on every open, which costs one read
and removes the whole class: a stale entry, a wrong `HARBOR_STORE_KEY`, a key
left behind by a restored backup. If the header says plaintext, no key is
applied, whatever the environment thinks. If it says encrypted and there is no
key, the error says so instead of claiming corruption.

Also: `readSecret` returned an empty string for a blank keychain entry, which
callers treated as a real value. Empty is now null.

And `src/kernel/imports.test.ts` is in the suite, which is the test whose absence
let 0.35.0 ship broken: it imports every module in the build. Typecheck passed
then because the types were installed, the build passed because `tsc` does not
resolve runtime dependencies, and all 38 tests passed because none of them
imported the one file that was wrong.

## 0.35.3

`harbor dev install-service` produced a LaunchAgent that exited 1 and appeared to
log nothing.

It was logging. The plist sent stdout to `harbor.log` and stderr to
`harbor.err.log`, and the instructions the command prints tell you to tail
`harbor.log`. A daemon that fails at startup writes only to stderr, so the file
you are told to watch is the one file guaranteed to be empty in the case you are
watching for.

Both streams now go to one file. Splitting them is right for a service somebody
already understands and wrong for the first thirty seconds of running one.

The agent also gets an explicit `PATH`. launchd hands a process
`/usr/bin:/bin:/usr/sbin:/sbin` and the keychain shells out to
`/usr/bin/security`, so this is insurance rather than a known failure.

## 0.35.4

Encryption locked its owner out of his own store for half an hour. Nothing was
lost, and none of the three things that went wrong were subtle.

**The key was chosen by source instead of by whether it works.** A key from an
earlier attempt was in the keychain, the store was encrypted with a newer one,
and the lookup preferred the keychain. Setting the correct key in
`HARBOR_STORE_KEY` therefore did nothing at all: the wrong one was found first
and never tested against the file. Every candidate is now tried and the one that
opens the store wins, because a key is not a setting with a precedence order.

**The keychain write was assumed rather than verified.** `--enable` reported
"the key is in your keychain" because `security` did not exit non-zero. The key
was not there. `delete-generic-password` removes one matching item, so a
duplicate entry survived and lookups kept returning the old value. The key is
now read back and compared, and `--enable` says plainly when the keychain
refused it.

**The first symptom pointed at the wrong thing.** Applying a key to a plaintext
database makes it unreadable and the driver says "file is not a database", which
reads exactly like corruption. That is what the very first `relate --rebuild`
failure was, and fixing the symptom in 0.35.2 without explaining where the key
came from left the real fault in place for another two hours.

What actually held: the store was never damaged, both backups opened with the
printed key, and the pre-encryption copy had been correctly removed. The
recovery path worked. The way in was blocked by a lookup rule, not by
cryptography.

## 0.35.5

Three reporting failures around the same incident. None of them broke anything;
all three told somebody the wrong thing while they were trying to fix a real
problem, which is its own kind of damage.

**`doctor` said "the key is in the keychain" whenever the store was encrypted**,
without checking whether that key opened anything. On the one morning it
mattered, the keychain held a key that opened nothing and `doctor` reported the
store healthy while the daemon crash-looped. It now tries the keys, reports
which one works, and says explicitly when the working key came from
`HARBOR_STORE_KEY`, because anything that does not inherit a shell (a daemon, a
LaunchAgent) will not find it there.

**`doctor` called a backup unencrypted because of its filename.** A `VACUUM
INTO` snapshot taken from an encrypted store inherits the cipher, so a `.db`
name says nothing about the contents. It read the header of the one file it was
complaining about, found it encrypted, and still reported a problem with a fix
that would have deleted a perfectly good backup. Classification is by header
now, for both formats.

**`install-service` wrote a plist for a service that could not start.** launchd
does not run a login shell, so it never reads `.bashrc`: a key exported there
works in a terminal and is invisible to the daemon, and the only symptom is a
crash loop against a log nobody is watching. The command now checks whether the
keychain holds a key that actually opens the store and says so, with the two
commands that fix it, before you install anything.
