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

  <key>StandardOutPath</key>
  <string>${join(logDir, "harbor.log")}</string>

  <key>StandardErrorPath</key>
  <string>${join(logDir, "harbor.err.log")}</string>
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

export function installInstructions(platform: NodeJS.Platform, path: string): readonly string[] {
  if (platform === "darwin") {
    return [
      `Wrote ${path}`,
      "",
      "Install it with:",
      `  cp ${path} ~/Library/LaunchAgents/com.harbor.daemon.plist`,
      "  launchctl load ~/Library/LaunchAgents/com.harbor.daemon.plist",
      "",
      "Check it with:",
      "  launchctl list | grep harbor",
      "  tail -f ~/.harbor/logs/harbor.log",
      "",
      "Stop it with:",
      "  launchctl unload ~/Library/LaunchAgents/com.harbor.daemon.plist",
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
