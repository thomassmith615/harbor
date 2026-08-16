# run.sh, two modes

```
./run.sh          get current and leave everything running, for using the UI
./run.sh --check  the full verification pass, for after a code drop
```

Both kill any daemon they find first, so both are safe to re-run with nothing to
undo in between.

## Default mode, in order, and why that order

**Ollama first.** Before anything touches the pipeline. Without it `derive`
returns `skipped: no embedding backend` and does nothing, semantic search
silently falls back to keyword-only, and the UI looks like it has lost your
history. That is not a hypothetical; it is what sent us looking at the iMessage
connector for an afternoon. The script starts it, waits for it to answer, and
dies if `nomic-embed-text` is not pulled.

**Build gate.** Quiet unless it fails.

**Daemon before the sync.** `harbor update` enqueues an onboard job and the
daemon is what runs it. Started first, the work shows up in `harbor jobs` and
survives this script exiting.

**`harbor update`, then wait.** onboard is recent sync, then classify, derive,
resolve, relate, signals. Recent messages land first so Harbor is answerable
within a minute or two while older history fills in behind. The script polls
`harbor jobs` until nothing is running, up to about 7 minutes, then prints the
job list either way rather than blocking forever. It only inspects the most
recent few jobs, because an older one orphaned in `running` would otherwise hold
the loop open for its whole budget.

**Then what you need for the UI:** the localhost URL, the LAN URL with your
actual current address (it changed from 192.168.6.20 to 10.0.0.54 between two of
your runs, so it is read fresh each time), and a **fresh pairing code**. The
built-in page redeems one at `/pair`. Single use and short-lived, which beats
hunting for an old token. Issued with `--act` to match your existing devices.

## --check mode

Everything above, then the three verification blocks: marker manifest and the
src-versus-dist comparison, the two-directional attribution assertion, and
situations plus doctor. Use it after a drop; skip it when you just want to test.

## Coverage is printed on purpose

The status block prints the coverage table before handing you the URL, so you
can see how far back each kind actually reaches before you start judging
answers. A confidently incomplete answer looks exactly like a wrong one.
