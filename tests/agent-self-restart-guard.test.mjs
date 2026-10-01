// An agent must never restart the daemon it is running inside.
//
// Incident (2026-10-01, doingbox): an agent ran
// `sudo systemctl restart ares-garrison` mid-turn to pick up a systemd drop-in.
// The tool call never returned — the turn died with the process — and its
// startup-recovery replay was invisible to the phone, so the owner watched the
// agent go dark and called it bricked. Every other agent in that process was cut
// off with it. Bypass mode does not lift this refusal; ares-safe-restart is the
// sanctioned, detached, idle-waiting path.
import assert from "node:assert/strict";
import test from "node:test";

import { irrecoverableShellRefusal, selfHostKillRefusal } from "../packages/tools/dist/index.js";

const refused = [
  "sudo systemctl restart ares-garrison",
  "sudo systemctl restart ares-garrison.service",
  "systemctl --no-block restart ares-garrison",
  "sudo systemctl daemon-reload && sudo systemctl restart ares-garrison",
  "systemctl stop ares-garrison",
  "sudo systemctl kill ares-garrison",
  "sudo systemctl try-restart ares-partner",
  "sudo systemctl restart ares-instance-muse",
  "sudo systemctl disable --now ares-garrison",
  "sudo service ares-garrison restart",
  "pkill -f entry.js",
  "pkill -f 'garrison serve'",
  "killall node",
];

const allowed = [
  "systemctl status ares-garrison",
  "systemctl is-active ares-garrison",
  "systemctl show ares-garrison -p NRestarts",
  "systemctl cat ares-garrison",
  "journalctl -u ares-garrison --since -10min",
  "sudo systemctl restart jellyfin",
  "sudo systemctl restart claude-remote",
  "ares-safe-restart ares-garrison \"pick up DISPLAY drop-in\"",
  "/home/mrdoing/Ares/scripts/ares-safe-restart.sh ares-garrison reason",
  "pkill -f qbittorrent",
];

for (const command of refused) {
  test(`refuses agent self-kill: ${command}`, () => {
    const reason = selfHostKillRefusal(command);
    assert.ok(reason, "expected a refusal");
    assert.match(reason, /ares-safe-restart/, "refusal must name the safe path");
    // Wired through the irrecoverable gate, which runs even in bypass mode.
    assert.equal(irrecoverableShellRefusal(command), reason);
  });
}

for (const command of allowed) {
  test(`leaves non-self-kill commands alone: ${command}`, () => {
    assert.equal(selfHostKillRefusal(command), null);
  });
}
