import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsTask, launchdPlist, systemdUnit, launchdPath, systemdPath } from '../src/autostart.js';

const opts = { root: '/home/u/Dash Bank', nodePath: '/usr/bin/node' };

test('windows task runs at logon and logs to data/', () => {
  const t = windowsTask({ root: 'C:\\Users\\u\\DashBank', nodePath: 'C:\\Program Files\\nodejs\\node.exe' });
  assert.equal(t.create[0], 'schtasks');
  assert.ok(t.create[1].includes('ONLOGON'));
  const tr = t.create[1][t.create[1].indexOf('/TR') + 1];
  assert.match(tr, /"C:\\Program Files\\nodejs\\node.exe"/);
  assert.match(tr, /dashbank\.log/);
  assert.deepEqual(t.remove[1], ['/Delete', '/TN', 'DashBank', '/F']);
});

test('launchd plist escapes XML and keeps alive', () => {
  const p = launchdPlist({ ...opts, root: '/Users/u/A&B' });
  assert.match(p, /A&amp;B/);
  assert.match(p, /<key>KeepAlive<\/key><true\/>/);
  assert.equal(launchdPath('/Users/u'), '/Users/u/Library/LaunchAgents/com.dashbank.app.plist');
});

test('systemd unit quotes paths with spaces', () => {
  const u = systemdUnit(opts);
  assert.match(u, /ExecStart=\/usr\/bin\/node --disable-warning=ExperimentalWarning "\/home\/u\/Dash Bank\/src\/index.js"/);
  assert.match(u, /Restart=on-failure/);
  assert.equal(systemdPath('/home/u'), '/home/u/.config/systemd/user/dashbank.service');
});
