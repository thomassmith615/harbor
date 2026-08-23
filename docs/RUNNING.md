# Leaving Harbor running, and reaching it from anywhere

Two problems, and they are separate. Staying up is a supervisor problem.
Reaching it is a network problem. Solving the second one inside Harbor would
mean putting a mail archive on the internet, which is what the encryption work
existed to prevent.

Both answers here are free.

## Staying up

```
harbor install-service
```

That writes `~/.harbor/com.harbor.daemon.plist` and prints the two commands to
install it. It does not install it for you: writing to `LaunchAgents` on
somebody's behalf is the kind of helpfulness that is very annoying the first
time it does the wrong thing.

The plist binds `127.0.0.1`. Leave it that way. Nothing outside the machine
needs to reach the port directly, and the next section is why.

Three things launchd cannot solve for you.

**A LaunchAgent starts at login, not at boot.** This is not a limitation to work
around. The store key lives in the keychain, and the keychain unlocks at login,
so before you log in Harbor could not open the database anyway. A LaunchDaemon
would start earlier and fail. After a restart, log in and Harbor comes up.

**macOS sleeps when the lid closes, and power makes no difference.** Lid open
with sleep disabled is the arrangement that works:

```
sudo pmset -c disablesleep 1     # undo with 0
```

Display sleep is on its own timer, so the screen still goes dark. If this
machine is also the one you carry around, that is the real argument for moving
Harbor to something that lives in a closet. Nothing here assumes a particular
host: moving it is a copy of `~/.harbor` plus one keychain entry.

**Ollama has to be running or `derive` does nothing.** It returns "skipped: no
embedding backend", semantic search quietly falls back to keyword only, and
Harbor looks like it has lost your history. Keep Ollama in Login Items, or run
it under its own agent.

Check on it:

```
launchctl print gui/$(id -u)/com.harbor.daemon | head -20
tail -f ~/.harbor/logs/harbor.log
```

`launchctl list | grep harbor` gives a pid and an exit code and nothing else.
`print` gives the program, its arguments, the last exit reason and where it is
logging. Use `bootstrap` and `bootout` rather than `load` and `unload`: the old
verbs report `Input/output error` for everything from an already-loaded job to a
malformed plist, and in the first case load it anyway, so you see a failure and
a running job and cannot tell which happened.

## Turning it all off

```
./run.sh off
```

Harbor can be running in four places at once: a daemon you started by hand, the
LaunchAgent, the Tailscale proxy publishing the port, and a sleep setting
holding the machine awake for it. Killing the one you can see leaves the other
three, and launchd restarts its copy thirty seconds later, which reads as Harbor
refusing to die.

That stops all four, then checks nothing is answering on 8484, which is a
different claim from having signalled some processes. It touches no data.

Note that two of them fight. `./run.sh local` binds `0.0.0.0` and the
LaunchAgent binds `127.0.0.1` on the same port, so whichever starts second
cannot bind, and stopping one takes the other's job down mid-pass. A job that
failed with "the process running this stopped" is that. Every mode of `run.sh`
stops everything first for this reason, but starting the agent by hand
afterwards puts you back in the same place. Use one or the other.

## The three modes

```
./run.sh local     build, verify, serve on this machine and your wifi
./run.sh remote    build, verify, serve to your phone from anywhere
./run.sh off       stop everything. Touches no data.
```

`local` and `remote` differ in one thing: what the daemon binds to. Local binds
every interface so another device on your wifi can reach it directly. Remote
binds loopback only and lets Tailscale carry the traffic, which is the whole
reason no port is ever exposed. Each mode stops whatever the last one started.

## Reaching it from your phone

```
harbor remote
```

That checks the whole path and prints whichever step is missing, one at a time:
Tailscale not installed, installed but not connected, connected but publishing
nothing, publishing the wrong port. Once all four are done it prints the URL and
a pairing code.

Underneath it is [Tailscale](https://tailscale.com) on the free plan plus one
command, `tailscale serve --bg 8484`, which publishes
`https://<your-mac>.<your-tailnet>.ts.net` and proxies it to `127.0.0.1:8484`.
`harbor remote` does not run it for you, for the same reason `install-service`
writes a plist and does not install it.

What that buys, and why it is better than the alternatives:

- **Harbor stays on loopback.** No port is forwarded, no firewall rule is
  opened, and nothing is listening on your LAN, let alone the internet.
- **Real HTTPS, with a real certificate.** Not self-signed, so no warning to
  click through and no pinning to explain. The device token stops crossing the
  network in the clear, which is the one thing wrong with reaching Harbor over
  plain HTTP on a home network.
- **It is the same URL everywhere.** House wifi, phone network, someone else's
  wifi. There is no "am I home" branch.
- **Only your own devices can reach it.** A tailnet is a private network between
  machines you signed in, not a public hostname with a password.

Cloudflare Tunnel also works and terminates your traffic at a third party. Port
forwarding does not deserve a sentence.

Then, on the phone:

1. Open the URL. You will be asked to pair.
2. Type the code `harbor remote` printed. It is single use and expires in ten
   minutes; run it again for a new one.
3. Share, then Add to Home Screen. It opens without browser chrome.

The code carries write scope, which matters: without it the page can show what
is connected and cannot connect anything, and cannot start an operation.

The token is stored in that browser and survives refreshes. Revoke it with
`harbor device revoke`, or from `harbor devices`.

## When it is not working

The Run view leads with whether Harbor is answering, what version it is, and how
long it has been up. A daemon that keeps restarting under launchd answers every
request it is up for, so "up 40s" is the thing to look at, not "it responded".

If the page will not load at all:

```
launchctl list | grep harbor          # is the job there, and what was its exit code
tail -50 ~/.harbor/logs/harbor.log    # empty means it never started
curl -s localhost:8484/health         # is the daemon itself alive
harbor remote                         # is the path from outside still up
```

The commonest cause of a service that loads and dies is an environment variable
that lives in your shell profile. launchd does not run a login shell and never
sees it. Anything Harbor needs at run time belongs in `~/.harbor/.env`.
