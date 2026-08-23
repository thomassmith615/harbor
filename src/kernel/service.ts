/**
 * Service installation.
 *
 * Generates a launchd plist or systemd unit and tells you the one command to
 * run. Harbor does not install it for you: writing to LaunchAgents or calling
 * systemctl on someone's behalf is the kind of helpfulness that is very
 * annoying the first time it does the wrong thing.
 *
 * The daemon is a long-lived Node process, which needs three things a CLI does
 * not: restart on failure, log rotation, and a defined environment. All three
 * are the supervisor's job, which is why this file emits configuration rather
 * than implementing any of them.
 */
import { join } from "node:path";
import { harborHome } from "./paths.js";

export interface ServiceOptions {
  readonly nodePath: string;
  readonly entryPath: string;
  readonly port: number;
  readonly host: string;
  readonly timezone: string;
}

export function launchdPlist(options: ServiceOptions): string {
  const logDir = join(harborHome(), "logs");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.harbor.daemon</string>

  <key>ProgramArguments</key>
  <array>
    <string>${options.nodePath}</string>
    <string>${options.entryPath}</string>
    <string>daemon</string>
    <string>--port</string>
    <string>${String(options.port)}</string>
    <string>--host</string>
    <string>${options.host}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HARBOR_HOME</key>
    <string>${harborHome()}</string>
    <key>HARBOR_TIMEZONE</key>
    <string>${options.timezone}</string>
    <!-- launchd hands a process a near-empty PATH. The keychain shells out to
         /usr/bin/security, so this is insurance rather than decoration. -->
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>30</integer>

  <!-- Harbor is a background service, not something a person is waiting on.
       Saying so keeps macOS from treating it as an interactive app, and stops
       it competing for foreground scheduling on a laptop somebody is using. -->
  <key>ProcessType</key>
  <string>Background</string>

  <!-- A run is a sync, a derive pass and possibly an embedding batch. Killing
       it mid-transaction is the one thing a supervisor must not do to a store
       that is the whole product. -->
  <key>ExitTimeOut</key>
  <integer>60</integer>

  <key>StandardOutPath</key>
  <string>${join(logDir, "harbor.log")}</string>

  <key>StandardErrorPath</key>
  <string>${join(logDir, "harbor.log")}</string>
</dict>
</plist>
`;
}

export function systemdUnit(options: ServiceOptions): string {
  return `[Unit]
Description=Harbor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${options.nodePath} ${options.entryPath} daemon --port ${String(options.port)} --host ${options.host}
Environment=HARBOR_HOME=${harborHome()}
Environment=HARBOR_TIMEZONE=${options.timezone}
Restart=on-failure
RestartSec=30
# The store is the product. Do not let a supervisor kill a write mid-transaction.
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=default.target
`;
}

/**
 * bootstrap and bootout, not load and unload.
 *
 * `load` is deprecated and reports "Load failed: 5: Input/output error" for
 * everything from an already-loaded job to a plist with a bad key, then loads
 * it anyway in the first case. So you see a failure, run `launchctl list`, find
 * the job running, and have no idea which of those happened. `bootstrap` says
 * what was actually wrong.
 *
 * `launchctl list | grep harbor` has the same problem in miniature: it prints a
 * pid and an exit status and nothing about why. `launchctl print` gives the
 * program, the arguments, the last exit reason and the paths it is logging to,
 * which is what somebody grepping for their service actually wanted.
 */
export function installInstructions(platform: NodeJS.Platform, path: string): readonly string[] {
  if (platform === "darwin") {
    return [
      `Wrote ${path}`,
      "",
      "Install it with:",
      `  cp ${path} ~/Library/LaunchAgents/com.harbor.daemon.plist`,
      "  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.harbor.daemon.plist",
      "",
      "Check it with:",
      "  launchctl print gui/$(id -u)/com.harbor.daemon | head -20",
      "  tail -f ~/.harbor/logs/harbor.log",
      "",
      "Stop it with:",
      "  launchctl bootout gui/$(id -u)/com.harbor.daemon",
      "",
      "Restart it after a code change:",
      "  launchctl kickstart -k gui/$(id -u)/com.harbor.daemon",
      "",
      "Two things this cannot do for you:",
      "",
      "  A LaunchAgent starts at login, not at boot, and the keychain unlocks",
      "  at login too. After a restart Harbor is down until somebody logs in.",
      "  That is the correct trade for a store whose key lives in the keychain.",
      "",
      "  macOS sleeps when the lid closes, and power makes no difference.",
      "  Lid open with `pmset` sleep disabled is the setup that works:",
      "    sudo pmset -c disablesleep 1     (undo with 0)",
    ];
  }

  return [
    `Wrote ${path}`,
    "",
    "Install it with:",
    `  mkdir -p ~/.config/systemd/user && cp ${path} ~/.config/systemd/user/harbor.service`,
    "  systemctl --user daemon-reload",
    "  systemctl --user enable --now harbor",
    "",
    "Check it with:",
    "  systemctl --user status harbor",
    "  journalctl --user -u harbor -f",
  ];
}
