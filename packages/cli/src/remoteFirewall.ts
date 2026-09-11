// LAN reachability preflight.
//
// Everything about paired devices assumes a device on the owner's network can
// actually reach the owner's machine. On Windows that assumption is wrong by
// default: the firewall is on for all three profiles with an inbound policy of
// block, so a paired device's discovery probe and its agent connection are both
// dropped — silently, with no ICMP, no log the owner will ever look at, and a
// connector that just retries forever.
//
// That is the exact failure signature of every bug in this workstream: it works
// on the owner's own machine, fails off-box, and says nothing. So the pairing
// flow checks first and hands the owner one command, rather than shipping them
// a device that will never connect and no way to find out why.
//
// Adding the rule needs elevation, which Ares does not have and should not
// silently acquire. We detect, explain, and let the owner decide.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const FIREWALL_RULE_PREFIX = "Ares Remote";

export interface PortNeed {
  port: number;
  protocol: "TCP" | "UDP";
  why: string;
}

export function remotePortNeeds(agentPort: number, discoveryPort: number): PortNeed[] {
  return [
    { port: agentPort, protocol: "TCP", why: "paired devices connect here" },
    { port: discoveryPort, protocol: "UDP", why: "paired devices find this machine on the LAN" },
  ];
}

export interface FirewallStatus {
  /** Only Windows blocks by default in a way that silently breaks this. */
  platform: "windows" | "other";
  /** True when we positively confirmed rules exist for every needed port. */
  allowed: boolean;
  /** Null when we could not determine it (no elevation needed to read, but the
   *  cmdlet can still be unavailable) — reported as unknown, never as fine. */
  checked: boolean;
  missing: PortNeed[];
  /** Copy-pasteable elevated command that creates exactly what's missing. */
  fixCommand?: string;
}

/**
 * Build the elevated PowerShell that opens only what is needed, scoped to
 * private networks. Deliberately NOT `Any` profile: a rule that also applies on
 * a coffee-shop network is a worse default than a device that needs re-pairing
 * at home.
 */
export function firewallFixCommand(needs: readonly PortNeed[]): string {
  const parts = needs.map(
    (n) =>
      `New-NetFirewallRule -DisplayName '${firewallRuleName(n)}' ` +
      `-Direction Inbound -Action Allow -Protocol ${n.protocol} -LocalPort ${n.port} -Profile Private`,
  );
  return parts.join("; ");
}

/** The rule name this tool creates for a given port — also what it looks for. */
export function firewallRuleName(need: PortNeed): string {
  return `${FIREWALL_RULE_PREFIX} (${need.protocol} ${need.port})`;
}

/**
 * Is OUR rule present?
 *
 * Looks the rule up BY NAME rather than asking "is this port open by any rule",
 * because the general question is unanswerably slow: piping every inbound rule
 * through Get-NetFirewallPortFilter costs a WMI round-trip per rule and did not
 * finish in five MINUTES on a normal desktop. A preflight that hangs is worse
 * than no preflight.
 *
 * The trade is a false positive when the owner opened the port under some other
 * rule name: they get advice they do not need. That is a strictly better
 * failure than a device that silently never connects, and running the fix twice
 * is harmless.
 */
async function hasRule(need: PortNeed): Promise<boolean | null> {
  try {
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `if (Get-NetFirewallRule -DisplayName '${firewallRuleName(need)}' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
      ],
      { timeout: 15_000, windowsHide: true },
    );
    const out = stdout.trim();
    if (out.includes("yes")) return true;
    if (out.includes("no")) return false;
    return null;
  } catch {
    return null;
  }
}

export async function checkFirewall(agentPort: number, discoveryPort: number): Promise<FirewallStatus> {
  const needs = remotePortNeeds(agentPort, discoveryPort);
  if (process.platform !== "win32") {
    // macOS/Linux hosts generally accept inbound LAN traffic, and where they
    // don't the owner configured that deliberately. Claiming "allowed" here
    // would be a guess, so report the platform and make no promise.
    return { platform: "other", allowed: true, checked: false, missing: [] };
  }
  const missing: PortNeed[] = [];
  let anyUnknown = false;
  for (const need of needs) {
    const has = await hasRule(need);
    if (has === null) anyUnknown = true;
    else if (!has) missing.push(need);
  }
  return {
    platform: "windows",
    allowed: missing.length === 0 && !anyUnknown,
    checked: !anyUnknown,
    missing,
    ...(missing.length ? { fixCommand: firewallFixCommand(missing) } : {}),
  };
}

/** One-paragraph explanation for the owner, or null when nothing is wrong. */
export function firewallAdvice(status: FirewallStatus): string | null {
  if (status.platform !== "windows") return null;
  if (status.allowed) return null;
  if (!status.checked && status.missing.length === 0) {
    return "Could not read the Windows firewall rules, so LAN pairing may or may not be reachable. If a paired device never connects, that is the first thing to check.";
  }
  const ports = status.missing.map((n) => `${n.protocol} ${n.port} (${n.why})`).join(", ");
  return (
    `Windows Firewall is blocking inbound ${ports}. A paired device on your network will retry forever and never connect, ` +
    `with nothing logged to tell you why. Run this once in an ADMIN PowerShell:\n\n${status.fixCommand}`
  );
}
