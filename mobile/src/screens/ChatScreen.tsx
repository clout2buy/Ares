// The conversation. One session at a time; the transcript folds every
// gateway event (live or replayed history) through the same reducer.

import React from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActivityCard, ApprovalCard, Button, ConnectCard, PermissionCard } from "../components/Cards";
import { Composer } from "../components/Composer";
import type { GatewayClient, GatewayStatus } from "../gateway";
import { Markdown } from "../Markdown";
import { PROVIDER_LABELS } from "../prompts";
import { theme } from "../theme";
import { emptyTranscript, fold, nextKey, stripSystemNotes, type Item, type Transcript } from "../transcript";
import type { ServerFrame, SessionSummary, StagedApproval } from "../wire";

const HISTORY_LIMIT = 300;

/** The one-time note the model gets on a session this phone opened. */
const PHONE_PREAMBLE =
  "(System: This conversation is over the Ares iPhone app; the user is on their phone, away from the computer. " +
  "They cannot see your screen, tool output, or files — describe what matters, briefly. Keep replies phone-sized. " +
  "Do the task end-to-end and report the result; ask only when genuinely blocked.)";

interface Approval {
  staged: StagedApproval;
  verb?: "allow_once" | "deny";
}

export function ChatScreen({ client, initialSessionId, onSessionChange, onForget }: { client: GatewayClient; initialSessionId?: string; onSessionChange: (id: string) => void; onForget: () => void }) {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = React.useState<GatewayStatus>(client.status);
  const [statusDetail, setStatusDetail] = React.useState<string | undefined>();
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = React.useState<string | undefined>(initialSessionId);
  const [transcript, setTranscript] = React.useState<Transcript>(emptyTranscript());
  const [approvals, setApprovals] = React.useState<Approval[]>([]);
  const [picker, setPicker] = React.useState(false);
  const [now, setNow] = React.useState(Date.now());
  const preambleSent = React.useRef(new Set<string>());
  const sessionRef = React.useRef(sessionId);
  sessionRef.current = sessionId;

  // A running card wants its clock ticking.
  React.useEffect(() => {
    if (!transcript.busy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [transcript.busy]);

  const attach = React.useCallback(
    (id: string) => {
      setSessionId(id);
      onSessionChange(id);
      setTranscript(emptyTranscript());
      client.send({ type: "session.attach", sessionId: id });
      client.send({ type: "session.history", sessionId: id, limit: HISTORY_LIMIT });
    },
    [client, onSessionChange],
  );

  const createSession = React.useCallback(async () => {
    try {
      const session = await client.createSession();
      setSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)]);
      setSessionId(session.id);
      onSessionChange(session.id);
      setTranscript(emptyTranscript());
      setPicker(false);
    } catch {
      /* status bar shows we're offline */
    }
  }, [client, onSessionChange]);

  React.useEffect(() => {
    const offStatus = client.onStatus((next, detail) => {
      setStatus(next);
      setStatusDetail(detail);
    });
    const offFrame = client.onFrame((frame: ServerFrame) => {
      switch (frame.type) {
        case "welcome": {
          const list = (frame as { sessions: SessionSummary[] }).sessions ?? [];
          setSessions(list);
          const wanted = sessionRef.current;
          if (wanted && list.some((s) => s.id === wanted)) attach(wanted);
          else void createSession();
          return;
        }
        case "sessions":
          setSessions((frame as { sessions: SessionSummary[] }).sessions ?? []);
          return;
        case "session.created": {
          const session = (frame as { session: SessionSummary }).session;
          setSessions((prev) => (prev.some((s) => s.id === session.id) ? prev : [session, ...prev]));
          return;
        }
        case "session.history": {
          const f = frame as { sessionId: string; entries: Array<{ ts?: string; event: import("../wire").TurnEvent }> };
          if (f.sessionId !== sessionRef.current) return;
          let state = emptyTranscript();
          for (const entry of f.entries) {
            const at = entry.ts ? Date.parse(entry.ts) : Date.now();
            state = fold(state, entry.event, Number.isFinite(at) ? at : Date.now());
          }
          // History is the past: nothing in it is still running.
          if (state.busy) state = fold(state, { type: "turn_end" });
          setTranscript(state);
          return;
        }
        case "event": {
          const f = frame as { sessionId: string; event: import("../wire").TurnEvent };
          if (f.sessionId !== sessionRef.current) return;
          setTranscript((prev) => fold(prev, f.event));
          return;
        }
        case "approval.pending": {
          const staged = (frame as { staged: StagedApproval }).staged;
          setApprovals((prev) => (prev.some((a) => a.staged.id === staged.id) ? prev : [...prev, { staged }]));
          return;
        }
        case "error": {
          const message = String((frame as { message?: string }).message ?? "error");
          setTranscript((prev) => ({ ...prev, items: [...prev.items, { kind: "notice", key: nextKey("n"), text: message, tone: "error" }] }));
          return;
        }
        default:
          return;
      }
    });
    return () => {
      offStatus();
      offFrame();
    };
  }, [client, attach, createSession]);

  const send = (text: string) => {
    const id = sessionRef.current;
    if (!id) return;
    const steer = transcript.busy;
    let wire = text;
    if (!steer && !preambleSent.current.has(id) && !transcript.items.some((i) => i.kind === "assistant")) {
      preambleSent.current.add(id);
      wire = `${PHONE_PREAMBLE}\n\n${text}`;
    }
    setTranscript((prev) => ({ ...prev, items: [...prev.items, { kind: "user", key: nextKey("u"), text, steer: steer || undefined }], busy: true }));
    client.send({ type: "session.send", sessionId: id, text: wire, delivery: steer ? "steer" : "queue" });
    if (steer) setTranscript((prev) => fold(prev, { type: "steer_routed", inputId: "", disposition: "local" }));
  };

  const stop = () => {
    const id = sessionRef.current;
    if (id) client.send({ type: "session.interrupt", sessionId: id });
  };

  const decidePermission = (requestId: string, decision: import("../wire").PermissionDecision) => {
    const id = sessionRef.current;
    if (!id) return;
    client.send({ type: "permission.respond", sessionId: id, requestId, decision });
    setTranscript((prev) => fold(prev, { type: "permission_response", id: requestId, decision }));
  };

  const decideApproval = (approvalId: string, verb: "allow_once" | "deny") => {
    client.send({ type: "approval.respond", approvalId, verb });
    setApprovals((prev) => prev.map((a) => (a.staged.id === approvalId ? { ...a, verb } : a)));
  };

  const connect = (provider: string) => {
    const label = PROVIDER_LABELS[provider] ?? provider;
    send(`Connect ${label}: start the OAuth flow with the Connect tool and give me the sign-in link.`);
  };

  const current = sessions.find((s) => s.id === sessionId);
  const connected = status === "open";
  const statusLine = status === "open" ? undefined : status === "connecting" ? "Connecting…" : status === "unauthorized" ? `Rejected: ${statusDetail ?? "bad token"}` : `Offline — retrying (${statusDetail ?? "…"})`;

  const renderItem = ({ item }: { item: Item }) => {
    switch (item.kind) {
      case "user":
        return (
          <View style={styles.userRow}>
            <View style={styles.userBubble}>
              {item.steer ? <Text style={styles.steerTag}>↪ steer</Text> : null}
              <Text style={styles.userText}>{stripSystemNotes(item.text)}</Text>
            </View>
          </View>
        );
      case "assistant":
        return (
          <View style={styles.assistantRow}>
            <Markdown text={item.text} />
            {item.streaming ? <Text style={styles.cursor}>▍</Text> : null}
          </View>
        );
      case "activity":
        return <ActivityCard card={item.card} now={now} />;
      case "permission":
        return <PermissionCard toolName={item.toolName} detail={item.detail} reason={item.reason} decision={item.decision} onDecide={(d) => decidePermission(item.id, d)} />;
      case "connect":
        return <ConnectCard provider={item.provider} expired={item.expired} onConnect={() => connect(item.provider)} />;
      case "notice":
        return <Text style={[styles.notice, item.tone === "error" ? { color: theme.bad } : null]}>{item.text}</Text>;
      default:
        return null;
    }
  };

  // Newest at the bottom, with the list inverted so it sticks there.
  const data = React.useMemo(() => [...transcript.items].reverse(), [transcript.items]);

  return (
    <View style={[styles.wrap, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => setPicker(true)} style={styles.headerTitleWrap}>
          <Text style={styles.headerGlyph}>🜂</Text>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {current?.title && current.title !== "untitled session" ? current.title : "Ares"}
          </Text>
          <Text style={styles.headerChevron}>▾</Text>
        </Pressable>
        <Pressable onPress={() => void createSession()} style={styles.headerButton}>
          <Text style={styles.headerButtonText}>＋</Text>
        </Pressable>
      </View>
      {statusLine ? (
        <View style={[styles.statusBar, status === "unauthorized" ? { backgroundColor: "#4a1f1f" } : null]}>
          <Text style={styles.statusText}>{statusLine}</Text>
          {status === "unauthorized" ? <Button label="Re-pair" tone="muted" onPress={onForget} /> : null}
        </View>
      ) : null}
      {approvals.length > 0 ? (
        <View style={styles.approvals}>
          {approvals.map((a) => (
            <ApprovalCard key={a.staged.id} staged={a.staged} verb={a.verb} onDecide={(verb) => decideApproval(a.staged.id, verb)} />
          ))}
        </View>
      ) : null}
      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={insets.top}>
        <FlatList
          data={data}
          inverted
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          keyboardDismissMode="interactive"
          ListEmptyComponent={<Text style={styles.empty}>{connected ? "What's next?" : ""}</Text>}
        />
        <View style={{ paddingBottom: insets.bottom }}>
          <Composer busy={transcript.busy} connected={connected && !!sessionId} onSend={send} onStop={stop} />
        </View>
      </KeyboardAvoidingView>

      <Modal visible={picker} animationType="slide" onRequestClose={() => setPicker(false)}>
        <View style={[styles.wrap, { paddingTop: insets.top }]}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Sessions</Text>
            <Pressable onPress={() => setPicker(false)} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>✕</Text>
            </Pressable>
          </View>
          <FlatList
            data={sessions}
            keyExtractor={(s) => s.id}
            contentContainerStyle={styles.list}
            ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  attach(item.id);
                  setPicker(false);
                }}
                style={[styles.sessionRow, item.id === sessionId ? { borderColor: theme.accent } : null]}
              >
                <Text style={styles.sessionTitle} numberOfLines={1}>
                  {item.busy ? "● " : ""}{item.title || "untitled session"}
                </Text>
                <Text style={styles.sessionMeta}>
                  {item.surface ?? "?"} · {item.model}
                </Text>
              </Pressable>
            )}
          />
          <View style={{ padding: 16, paddingBottom: insets.bottom + 16, gap: 10 }}>
            <Button label="New session" onPress={() => void createSession()} />
            <Button label="Forget this garrison" tone="bad" onPress={onForget} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border },
  headerTitleWrap: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  headerGlyph: { color: theme.accent, fontSize: 20 },
  headerTitle: { color: theme.text, fontSize: 18, fontWeight: "700", flexShrink: 1 },
  headerChevron: { color: theme.muted },
  headerButton: { width: 34, height: 34, borderRadius: 17, backgroundColor: theme.panel, alignItems: "center", justifyContent: "center" },
  headerButtonText: { color: theme.text, fontSize: 18 },
  statusBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: theme.panelRaised, paddingHorizontal: 14, paddingVertical: 8 },
  statusText: { color: theme.muted, fontSize: 13, flexShrink: 1 },
  approvals: { padding: 12, gap: 8 },
  body: { flex: 1 },
  list: { padding: 14, gap: 0 },
  userRow: { flexDirection: "row", justifyContent: "flex-end" },
  userBubble: { maxWidth: "85%", backgroundColor: theme.userBubble, borderRadius: 16, borderBottomRightRadius: 4, paddingHorizontal: 14, paddingVertical: 10 },
  userText: { color: theme.text, fontSize: 16, lineHeight: 22 },
  steerTag: { color: theme.accent, fontSize: 11, fontWeight: "700", marginBottom: 2 },
  assistantRow: { paddingRight: 8 },
  cursor: { color: theme.accent, fontSize: 16 },
  notice: { color: theme.muted, fontSize: 13, textAlign: "center" },
  empty: { color: theme.muted, textAlign: "center", marginTop: 40, transform: [{ scaleY: -1 }] },
  sessionRow: { backgroundColor: theme.panel, borderRadius: 12, borderWidth: 1, borderColor: theme.border, padding: 12, gap: 4 },
  sessionTitle: { color: theme.text, fontSize: 15, fontWeight: "600" },
  sessionMeta: { color: theme.muted, fontSize: 12 },
});
