// The cards a turn produces besides plain text: the activity card (what Ares
// is doing), a permission prompt, a staged approval, and a connector offer.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { cardSummary, formatDuration, type ActivityCardState } from "../activity";
import { PROVIDER_LABELS } from "../prompts";
import { theme } from "../theme";
import type { PermissionDecision, StagedApproval } from "../wire";

const MAX_VISIBLE_STEPS = 8;

export function ActivityCard({ card, now }: { card: ActivityCardState; now: number }) {
  const { headline, failed } = cardSummary(card, now);
  const [expanded, setExpanded] = React.useState(!card.done);
  React.useEffect(() => {
    if (card.done) setExpanded(false);
  }, [card.done]);
  const tone = card.done ? (failed > 0 ? theme.warn : theme.ok) : theme.accent;
  const hidden = Math.max(0, card.steps.length - MAX_VISIBLE_STEPS);
  return (
    <Pressable onPress={() => setExpanded((v) => !v)} style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={[styles.cardGlyph, { color: tone }]}>{card.done ? (failed > 0 ? "⚠" : "✓") : card.steering ? "↪" : "🜂"}</Text>
        <Text style={[styles.cardTitle, { color: tone }]}>{headline}</Text>
        {card.done && card.steps.length > 0 ? <Text style={styles.cardChevron}>{expanded ? "▾" : "▸"}</Text> : null}
      </View>
      {expanded && card.steps.length > 0 ? (
        <View style={styles.steps}>
          {hidden > 0 ? <Text style={styles.stepMuted}>… +{hidden} earlier</Text> : null}
          {card.steps.slice(-MAX_VISIBLE_STEPS).map((step) => {
            const took = formatDuration((step.endedAt ?? now) - step.startedAt);
            const glyph = step.state === "running" ? "⚙" : step.state === "ok" ? "✓" : "✗";
            const color = step.state === "running" ? theme.muted : step.state === "ok" ? theme.ok : theme.bad;
            return (
              <View key={step.id + step.startedAt} style={styles.stepRow}>
                <Text style={[styles.stepGlyph, { color }]}>{glyph}</Text>
                <Text style={styles.stepLabel} numberOfLines={2}>
                  {step.label}
                  <Text style={styles.stepMuted}> · {took}</Text>
                  {step.detail ? <Text style={{ color: theme.bad }}> — {step.detail}</Text> : null}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </Pressable>
  );
}

export function PermissionCard({
  toolName,
  detail,
  reason,
  decision,
  onDecide,
}: {
  toolName: string;
  detail?: string;
  reason: string;
  decision?: PermissionDecision;
  onDecide: (decision: PermissionDecision) => void;
}) {
  return (
    <View style={[styles.card, styles.promptCard]}>
      <Text style={styles.promptTitle}>🛡 Permission needed · {toolName}</Text>
      {detail ? <Text style={styles.promptDetail}>↳ {detail}</Text> : null}
      {reason ? <Text style={styles.promptReason}>{reason}</Text> : null}
      {decision ? (
        <Text style={[styles.outcome, { color: decision === "deny" ? theme.bad : theme.ok }]}>
          {decision === "deny" ? "🚫 Denied" : decision === "allow_always" ? "✅ Always allowed" : "✅ Allowed"}
        </Text>
      ) : (
        <View style={styles.buttonRow}>
          <Button label="Allow" onPress={() => onDecide("allow_once")} />
          <Button label="Always" onPress={() => onDecide("allow_always")} />
          <Button label="Deny" tone="bad" onPress={() => onDecide("deny")} />
        </View>
      )}
    </View>
  );
}

export function ApprovalCard({ staged, verb, onDecide }: { staged: StagedApproval; verb?: "allow_once" | "deny"; onDecide: (verb: "allow_once" | "deny") => void }) {
  return (
    <View style={[styles.card, styles.promptCard]}>
      <Text style={styles.promptTitle}>🛡 Approval required · {staged.kind}{staged.domain ? ` (${staged.domain})` : ""}</Text>
      {staged.reason ? <Text style={styles.promptReason}>{staged.reason}</Text> : null}
      {verb ? (
        <Text style={[styles.outcome, { color: verb === "deny" ? theme.bad : theme.ok }]}>{verb === "deny" ? "🚫 Denied" : "✅ Approved"}</Text>
      ) : (
        <View style={styles.buttonRow}>
          <Button label="Approve" onPress={() => onDecide("allow_once")} />
          <Button label="Deny" tone="bad" onPress={() => onDecide("deny")} />
        </View>
      )}
    </View>
  );
}

export function ConnectCard({ provider, expired, onConnect }: { provider: string; expired: boolean; onConnect: () => void }) {
  const label = PROVIDER_LABELS[provider] ?? provider;
  return (
    <View style={[styles.card, styles.promptCard]}>
      <Text style={styles.promptTitle}>🔗 {label} {expired ? "needs re-authorizing" : "isn't connected yet"}</Text>
      <Text style={styles.promptReason}>{expired ? "Its access expired — that's why that just failed." : "That's why that just failed."}</Text>
      <View style={styles.buttonRow}>
        <Button label={`Connect ${label}`} onPress={onConnect} />
      </View>
    </View>
  );
}

export function Button({ label, onPress, tone = "accent" }: { label: string; onPress: () => void; tone?: "accent" | "bad" | "muted" }) {
  const bg = tone === "accent" ? theme.accent : tone === "bad" ? "#4a1f1f" : theme.panelRaised;
  const fg = tone === "accent" ? "#1a0d00" : tone === "bad" ? theme.bad : theme.text;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: pressed ? 0.7 : 1 }]}>
      <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.panel, borderColor: theme.border, borderWidth: 1, borderRadius: 12, padding: 12, gap: 6 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardGlyph: { fontSize: 15 },
  cardTitle: { flex: 1, fontSize: 14, fontWeight: "600" },
  cardChevron: { color: theme.muted },
  steps: { gap: 4, marginTop: 4 },
  stepRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  stepGlyph: { width: 16, fontSize: 13, lineHeight: 18 },
  stepLabel: { flex: 1, color: theme.text, fontSize: 13, lineHeight: 18 },
  stepMuted: { color: theme.muted, fontSize: 13 },
  promptCard: { borderColor: theme.accent + "55" },
  promptTitle: { color: theme.text, fontWeight: "700", fontSize: 14 },
  promptDetail: { color: "#ffd9b8", fontFamily: "Menlo", fontSize: 13 },
  promptReason: { color: theme.muted, fontSize: 13, lineHeight: 18 },
  outcome: { fontSize: 13, fontWeight: "600", marginTop: 2 },
  buttonRow: { flexDirection: "row", gap: 8, marginTop: 6, flexWrap: "wrap" },
  button: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 9 },
  buttonText: { fontWeight: "700", fontSize: 14 },
});
