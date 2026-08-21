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
launchctl list | grep harbor
tail -f ~/.harbor/logs/harbor.log
```

## Reaching it from your phone

[Tailscale](https://tailscale.com), on the free plan, then one command:

```
tailscale serve --bg 8484
```

That publishes `https://<your-mac>.<your-tailnet>.ts.net` and proxies it to
`127.0.0.1:8484`.

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
2. On the Mac: `harbor device code --act`
3. Type the code. `--act` matters: without write scope the page can show what is
   connected and cannot connect anything, and cannot start an operation.
4. Share, then Add to Home Screen. It opens without browser chrome.

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
tailscale serve status                # is the proxy still published
```

The commonest cause of a service that loads and dies is an environment variable
that lives in your shell profile. launchd does not run a login shell and never
sees it. Anything Harbor needs at run time belongs in `~/.harbor/.env`.
