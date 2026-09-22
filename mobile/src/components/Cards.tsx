// The cards a turn produces besides plain text: the thinking bubble (the
// model reasoning), the activity timeline (what it's doing), a permission
// prompt, a staged approval, and a connector offer.

import React from "react";
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { cardSummary, formatDuration, type ActivityCardState } from "../activity";
import { Markdown } from "../Markdown";
import { PROVIDER_LABELS } from "../prompts";
import { radius, theme } from "../theme";
import type { PermissionDecision, StagedApproval } from "../wire";

const MAX_VISIBLE_STEPS = 8;

/** Three dots that breathe — the universal "still thinking". */
function Dots() {
  const a = React.useRef([0, 1, 2].map(() => new Animated.Value(0.25))).current;
  React.useEffect(() => {
    const loops = a.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(v, { toValue: 1, duration: 420, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.25, duration: 420, useNativeDriver: true }),
          Animated.delay((2 - i) * 160),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [a]);
  return (
    <View style={styles.dots}>
      {a.map((v, i) => (
        <Animated.View key={i} style={[styles.dot, { opacity: v }]} />
      ))}
    </View>
  );
}

/**
 * The model's reasoning. Live: a muted card with the last few lines scrolling
 * in and breathing dots. Done: collapses to "Thought for 4s" — tap to reread.
 */
export function ThinkingBubble({ text, streaming, startedAt, endedAt, now }: { text: string; streaming: boolean; startedAt: number; endedAt?: number; now: number }) {
  const [open, setOpen] = React.useState(false);
  const took = formatDuration((endedAt ?? now) - startedAt);
  if (streaming) {
    // Show only the tail so the bubble stays phone-sized while it streams.
    const tail = text.trim().split("\n").filter(Boolean).slice(-4).join("\n");
    return (
      <View style={[styles.thinking, styles.thinkingLive]}>
        <View style={styles.thinkingHead}>
          <Text style={styles.thinkingLabel}>Thinking</Text>
          <Dots />
        </View>
        {tail ? <Markdown text={tail} muted /> : null}
      </View>
    );
  }
  return (
    <Pressable onPress={() => setOpen((v) => !v)} style={[styles.thinking, open ? null : styles.thinkingCollapsed]}>
      <View style={styles.thinkingHead}>
        <Text style={styles.thinkingLabelDone}>Thought for {took}</Text>
        <Text style={styles.chev}>{open ? "▾" : "▸"}</Text>
      </View>
      {open ? <Markdown text={text.trim()} muted /> : null}
    </Pressable>
  );
}

/** What Ares is doing: a compact timeline, expanded while it runs, a one-line
 *  receipt when it's done (tap to reopen). */
export function ActivityCard({ card, now }: { card: ActivityCardState; now: number }) {
  const { headline, failed } = cardSummary(card, now);
  const [expanded, setExpanded] = React.useState(!card.done);
  React.useEffect(() => {
    if (card.done) setExpanded(false);
  }, [card.done]);
  const tone = card.done ? (failed > 0 ? theme.warn : theme.ok) : theme.accent;
  const hidden = Math.max(0, card.steps.length - MAX_VISIBLE_STEPS);
  const visible = card.steps.slice(-MAX_VISIBLE_STEPS);
  return (
    <Pressable onPress={() => setExpanded((v) => !v)} style={styles.card}>
      <View style={styles.cardHead}>
        {card.done ? (
          <Text style={[styles.cardGlyph, { color: tone }]}>{failed > 0 ? "⚠" : "✓"}</Text>
        ) : (
          <ActivityIndicator size="small" color={theme.accent} style={{ transform: [{ scale: 0.8 }] }} />
        )}
        <Text style={[styles.cardTitle, { color: tone }]}>{card.steering && !card.done ? "Steering · " : ""}{headline}</Text>
        {card.steps.length > 0 ? <Text style={styles.chev}>{expanded ? "▾" : "▸"}</Text> : null}
      </View>
      {expanded && visible.length > 0 ? (
        <View style={styles.timeline}>
          {hidden > 0 ? <Text style={styles.earlier}>+{hidden} earlier</Text> : null}
          {visible.map((step, i) => {
            const took = formatDuration((step.endedAt ?? now) - step.startedAt);
            const color = step.state === "running" ? theme.accent : step.state === "ok" ? theme.ok : theme.bad;
            const last = i === visible.length - 1;
            return (
              <View key={step.id + step.startedAt} style={styles.stepRow}>
                <View style={styles.rail}>
                  <View style={[styles.node, { backgroundColor: color, borderColor: color }, step.state === "running" ? styles.nodeLive : null]} />
                  {!last ? <View style={styles.railLine} /> : null}
                </View>
                <View style={styles.stepBody}>
                  <Text style={[styles.stepLabel, step.state === "running" ? { color: theme.textStrong } : null]} numberOfLines={2}>
                    {step.label}
                  </Text>
                  {step.detail ? <Text style={styles.stepDetail} numberOfLines={2}>{step.detail}</Text> : null}
                </View>
                <Text style={[styles.stepTime, step.state === "running" ? { color: theme.accent } : null]}>{took}</Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </Pressable>
  );
}

export function PermissionCard({ toolName, detail, reason, decision, onDecide }: { toolName: string; detail?: string; reason: string; decision?: PermissionDecision; onDecide: (decision: PermissionDecision) => void }) {
  return (
    <View style={[styles.card, styles.promptCard]}>
      <View style={styles.promptHead}>
        <Text style={styles.promptIcon}>🛡</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.promptTitle}>Permission · {toolName}</Text>
          {reason ? <Text style={styles.promptReason}>{reason}</Text> : null}
        </View>
      </View>
      {detail ? (
        <View style={styles.detailBox}>
          <Text style={styles.detailText} numberOfLines={4}>{detail}</Text>
        </View>
      ) : null}
      {decision ? (
        <Text style={[styles.outcome, { color: decision === "deny" ? theme.bad : theme.ok }]}>
          {decision === "deny" ? "Denied" : decision === "allow_always" ? "Always allowed" : "Allowed"}
        </Text>
      ) : (
        <View style={styles.buttonRow}>
          <Button label="Allow" onPress={() => onDecide("allow_once")} />
          <Button label="Always" tone="muted" onPress={() => onDecide("allow_always")} />
          <Button label="Deny" tone="bad" onPress={() => onDecide("deny")} />
        </View>
      )}
    </View>
  );
}

export function ApprovalCard({ staged, verb, onDecide }: { staged: StagedApproval; verb?: "allow_once" | "deny"; onDecide: (verb: "allow_once" | "deny") => void }) {
  return (
    <View style={[styles.card, styles.promptCard]}>
      <View style={styles.promptHead}>
        <Text style={styles.promptIcon}>🛡</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.promptTitle}>Approval · {staged.kind}{staged.domain ? ` (${staged.domain})` : ""}</Text>
          {staged.reason ? <Text style={styles.promptReason}>{staged.reason}</Text> : null}
        </View>
      </View>
      {verb ? (
        <Text style={[styles.outcome, { color: verb === "deny" ? theme.bad : theme.ok }]}>{verb === "deny" ? "Denied" : "Approved"}</Text>
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
      <View style={styles.promptHead}>
        <Text style={styles.promptIcon}>🔗</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.promptTitle}>{label} {expired ? "needs re-authorizing" : "isn't connected"}</Text>
          <Text style={styles.promptReason}>{expired ? "Its access expired — that's why that just failed." : "That's why that just failed."}</Text>
        </View>
      </View>
      <View style={styles.buttonRow}>
        <Button label={`Connect ${label}`} onPress={onConnect} />
      </View>
    </View>
  );
}

export function Button({ label, onPress, tone = "accent" }: { label: string; onPress: () => void; tone?: "accent" | "bad" | "muted" }) {
  const bg = tone === "accent" ? theme.accent : tone === "bad" ? "rgba(255,92,92,0.14)" : theme.panelRaised;
  const fg = tone === "accent" ? "#1a0d00" : tone === "bad" ? theme.bad : theme.text;
  const border = tone === "accent" ? theme.accent : tone === "bad" ? "rgba(255,92,92,0.3)" : theme.borderStrong;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.button, { backgroundColor: bg, borderColor: border, opacity: pressed ? 0.7 : 1 }]}>
      <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.panel, borderColor: theme.border, borderWidth: 1, borderRadius: radius.card, padding: 12, gap: 8 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  cardGlyph: { fontSize: 14, width: 18, textAlign: "center" },
  cardTitle: { flex: 1, fontSize: 13.5, fontWeight: "600", letterSpacing: 0.1 },
  chev: { color: theme.faint, fontSize: 13 },
  timeline: { marginTop: 2, paddingLeft: 2 },
  earlier: { color: theme.faint, fontSize: 12, marginBottom: 6, marginLeft: 26 },
  stepRow: { flexDirection: "row", alignItems: "flex-start", minHeight: 26 },
  rail: { width: 18, alignItems: "center" },
  node: { width: 8, height: 8, borderRadius: 4, marginTop: 6, borderWidth: 1 },
  nodeLive: { width: 10, height: 10, borderRadius: 5, marginTop: 5, shadowColor: theme.accent, shadowOpacity: 0.9, shadowRadius: 6 },
  railLine: { flex: 1, width: 1.5, backgroundColor: theme.border, marginTop: 3, marginBottom: -3 },
  stepBody: { flex: 1, paddingLeft: 8, paddingBottom: 8 },
  stepLabel: { color: theme.muted, fontSize: 13.5, lineHeight: 19 },
  stepDetail: { color: theme.bad, fontSize: 12.5, lineHeight: 17, marginTop: 1 },
  stepTime: { color: theme.faint, fontSize: 12, fontFamily: "Menlo", marginTop: 2, marginLeft: 8 },
  thinking: { backgroundColor: "transparent", borderColor: theme.border, borderWidth: 1, borderRadius: radius.card, padding: 12, gap: 8 },
  thinkingLive: { backgroundColor: "rgba(255,255,255,0.025)" },
  thinkingCollapsed: { paddingVertical: 9 },
  thinkingHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  thinkingLabel: { color: theme.thinking, fontSize: 13.5, fontWeight: "600", fontStyle: "italic" },
  thinkingLabelDone: { color: theme.muted, fontSize: 13, fontWeight: "500", flex: 1 },
  dots: { flexDirection: "row", gap: 4, alignItems: "center" },
  dot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: theme.thinking },
  promptCard: { borderColor: "rgba(255,122,26,0.35)", backgroundColor: "#15120f" },
  promptHead: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  promptIcon: { fontSize: 16, marginTop: 1 },
  promptTitle: { color: theme.textStrong, fontWeight: "600", fontSize: 14.5 },
  promptReason: { color: theme.muted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  detailBox: { backgroundColor: theme.code, borderRadius: 8, padding: 10, borderWidth: 1, borderColor: theme.border },
  detailText: { color: theme.accentText, fontFamily: "Menlo", fontSize: 12.5, lineHeight: 17 },
  outcome: { fontSize: 13, fontWeight: "600" },
  buttonRow: { flexDirection: "row", gap: 8, marginTop: 2, flexWrap: "wrap" },
  button: { paddingVertical: 9, paddingHorizontal: 15, borderRadius: 10, borderWidth: 1 },
  buttonText: { fontWeight: "600", fontSize: 14 },
});
