// Pure builders for OS auto-start definitions (kept separate from the CLI so they can be tested).
import path from 'node:path';

export const SERVICE_NAME = 'DashBank';
const LAUNCHD_LABEL = 'com.dashbank.app';

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function nodeArgs(root) {
  return ['--disable-warning=ExperimentalWarning', path.join(root, 'src', 'index.js')];
}

/** Windows: Task Scheduler task that runs at logon, hidden, logging to data/dashbank.log. */
export function windowsTask({ root, nodePath }) {
  const log = path.win32.join(root, 'data', 'dashbank.log');
  const cmd = `cmd /c cd /d "${root}" && "${nodePath}" ${nodeArgs(root).map((a) => `"${a}"`).join(' ')} >> "${log}" 2>&1`;
  return {
    create: ['schtasks', ['/Create', '/TN', SERVICE_NAME, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F', '/TR', cmd]],
    remove: ['schtasks', ['/Delete', '/TN', SERVICE_NAME, '/F']],
  };
}

/** macOS: per-user LaunchAgent, restarted if it crashes. */
export function launchdPlist({ root, nodePath }) {
  const args = [nodePath, ...nodeArgs(root)].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  const log = xmlEscape(path.join(root, 'data', 'dashbank.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

export function launchdPath(home) {
  return path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/** Linux: systemd user unit. */
export function systemdUnit({ root, nodePath }) {
  return `[Unit]
Description=DashBank personal finance tracker
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${[nodePath, ...nodeArgs(root)].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

export function systemdPath(home) {
  return path.join(home, '.config', 'systemd', 'user', 'dashbank.service');
}
