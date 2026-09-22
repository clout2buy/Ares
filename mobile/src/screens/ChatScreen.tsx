// The conversation. One session at a time; the transcript folds every
// gateway event (live or replayed history) through one pure reducer. Voice,
// photos and screenshots ride the phone API on the same origin.

import React from "react";
import { Animated, FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { useAudioRecorder } from "expo-audio";
import { ActivityCard, ApprovalCard, Button, ConnectCard, PermissionCard, ThinkingBubble } from "../components/Cards";
import { Composer, type Draft } from "../components/Composer";
import type { GatewayClient, GatewayStatus } from "../gateway";
import { Markdown } from "../Markdown";
import { PROVIDER_LABELS } from "../prompts";
import { radius, theme } from "../theme";
import { emptyTranscript, fold, nextKey, stripSystemNotes, type Item, type Transcript } from "../transcript";
import { RECORDING, afterRecording, ensureMicrophone, speak, stopSpeaking, transcribeFile } from "../voice";
import type { PermissionDecision, ServerFrame, SessionAttachment, SessionSummary, StagedApproval, TurnEvent } from "../wire";

const HISTORY_LIMIT = 300;
/** The garrison caps each image at ~1.5 MB of base64. */
const MAX_IMAGE_BASE64 = 1_500_000;

/** The one-time note the model gets on a session this phone opened. */
const PHONE_PREAMBLE =
  "(System: This conversation is over the Ares iPhone app; the user is on their phone, away from the computer. " +
  "They cannot see your screen, tool output, or files — describe what matters, briefly. Keep replies phone-sized. " +
  "Screenshots you take with ComputerUse are shown to them automatically. " +
  "Do the task end-to-end and report the result; ask only when genuinely blocked.)";

interface Approval {
  staged: StagedApproval;
  verb?: "allow_once" | "deny";
}

const EMPTY_DRAFT: Draft = { text: "", images: [] };

export function ChatScreen({
  client,
  origin,
  token,
  initialSessionId,
  onSessionChange,
  onForget,
}: {
  client: GatewayClient;
  /** https origin of the phone API (screenshots, voice). */
  origin: string;
  token: string;
  initialSessionId?: string;
  onSessionChange: (id: string) => void;
  onForget: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = React.useState<GatewayStatus>(client.status);
  const [statusDetail, setStatusDetail] = React.useState<string | undefined>();
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = React.useState<string | undefined>(initialSessionId);
  const [transcript, setTranscript] = React.useState<Transcript>(emptyTranscript());
  const [approvals, setApprovals] = React.useState<Approval[]>([]);
  const [picker, setPicker] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft>(EMPTY_DRAFT);
  const [speakReplies, setSpeakReplies] = React.useState(false);
  const [listening, setListening] = React.useState(false);
  const [now, setNow] = React.useState(Date.now());
  const preambleSent = React.useRef(new Set<string>());
  const sessionRef = React.useRef(sessionId);
  sessionRef.current = sessionId;
  const speakRef = React.useRef(speakReplies);
  speakRef.current = speakReplies;
  const recorder = useAudioRecorder(RECORDING);
  const pulse = React.useRef(new Animated.Value(1)).current;

  // A running card wants its clock ticking, and the flame breathes.
  React.useEffect(() => {
    if (!transcript.busy) {
      pulse.setValue(1);
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      clearInterval(timer);
      loop.stop();
    };
  }, [transcript.busy, pulse]);

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
          const f = frame as { sessionId: string; entries: Array<{ ts?: string; event: TurnEvent }> };
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
          const f = frame as { sessionId: string; event: TurnEvent };
          if (f.sessionId !== sessionRef.current) return;
          const event = f.event;
          if (event.type === "permission_request") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          if (event.type === "turn_end") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setTranscript((prev) => {
            const next = fold(prev, event);
            if (event.type === "turn_end" && speakRef.current) {
              // Speak what this turn said — every assistant bubble since the
              // owner's last message, joined.
              const said: string[] = [];
              for (let i = next.items.length - 1; i >= 0; i--) {
                const item = next.items[i];
                if (item.kind === "user") break;
                if (item.kind === "assistant") said.unshift(item.text);
              }
              const text = said.join("\n").trim();
              if (text) void speak(origin, token, text).catch(() => undefined);
            }
            return next;
          });
          return;
        }
        case "approval.pending": {
          const staged = (frame as { staged: StagedApproval }).staged;
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
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
  }, [client, attach, createSession, origin, token]);

  const sendText = (text: string, images: Draft["images"] = []) => {
    const id = sessionRef.current;
    if (!id) return;
    const steer = transcript.busy;
    let wire = text || (images.length > 0 ? "(The user sent a photo. Look at it and respond to what it shows.)" : "");
    if (!wire) return;
    if (!steer && !preambleSent.current.has(id) && !transcript.items.some((i) => i.kind === "assistant")) {
      preambleSent.current.add(id);
      wire = `${PHONE_PREAMBLE}\n\n${wire}`;
    }
    const attachments: SessionAttachment[] = images.map((img) => ({ kind: "image", mediaType: img.mediaType, data: img.base64 }));
    setTranscript((prev) => ({
      ...prev,
      items: [...prev.items, { kind: "user", key: nextKey("u"), text, steer: steer || undefined, images: images.length ? images.map((i) => i.uri) : undefined }],
      busy: true,
    }));
    client.send({
      type: "session.send",
      sessionId: id,
      text: wire,
      delivery: steer ? "steer" : "queue",
      ...(attachments.length ? { attachments } : {}),
    });
    if (steer) setTranscript((prev) => fold(prev, { type: "steer_routed", inputId: "", disposition: "local" }));
    stopSpeaking();
  };

  const sendDraft = () => {
    const text = draft.text.trim();
    if (!text && draft.images.length === 0) return;
    sendText(text, draft.images);
    setDraft(EMPTY_DRAFT);
  };

  const stop = () => {
    const id = sessionRef.current;
    if (id) client.send({ type: "session.interrupt", sessionId: id });
    stopSpeaking();
  };

  const pickPhoto = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.55, allowsMultipleSelection: true, selectionLimit: 4 });
    if (result.canceled) return;
    const picked: Draft["images"] = [];
    for (const asset of result.assets) {
      if (!asset.base64 || asset.base64.length > MAX_IMAGE_BASE64) continue;
      const mediaType = asset.mimeType === "image/png" ? "image/png" : asset.mimeType === "image/webp" ? "image/webp" : asset.mimeType === "image/gif" ? "image/gif" : "image/jpeg";
      picked.push({ uri: asset.uri, base64: asset.base64, mediaType });
    }
    if (picked.length < result.assets.length) {
      setTranscript((prev) => ({ ...prev, items: [...prev.items, { kind: "notice", key: nextKey("n"), text: "Some photos were too large to send (1.5 MB cap).", tone: "info" }] }));
    }
    setDraft((prev) => ({ ...prev, images: [...prev.images, ...picked].slice(0, 4) }));
  };

  const holdMicStart = async () => {
    if (listening) return;
    if (!(await ensureMicrophone())) return;
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      setListening(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {
      setListening(false);
    }
  };

  const holdMicEnd = async () => {
    if (!listening) return;
    setListening(false);
    try {
      await recorder.stop();
      await afterRecording();
      const uri = recorder.uri;
      if (!uri) return;
      const text = await transcribeFile(origin, token, uri);
      if (!text) {
        setTranscript((prev) => ({ ...prev, items: [...prev.items, { kind: "notice", key: nextKey("n"), text: "Couldn't make that out — try again.", tone: "info" }] }));
        return;
      }
      // Spoken words go straight out; typing first was the point of the mic.
      sendText(text, draft.images);
      setDraft(EMPTY_DRAFT);
    } catch (err) {
      setTranscript((prev) => ({ ...prev, items: [...prev.items, { kind: "notice", key: nextKey("n"), text: `Voice failed: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }] }));
    }
  };

  const decidePermission = (requestId: string, decision: PermissionDecision) => {
    const id = sessionRef.current;
    if (!id) return;
    client.send({ type: "permission.respond", sessionId: id, requestId, decision });
    setTranscript((prev) => fold(prev, { type: "permission_response", id: requestId, decision }));
    void Haptics.selectionAsync();
  };

  const decideApproval = (approvalId: string, verb: "allow_once" | "deny") => {
    client.send({ type: "approval.respond", approvalId, verb });
    setApprovals((prev) => prev.map((a) => (a.staged.id === approvalId ? { ...a, verb } : a)));
  };

  const connect = (provider: string) => {
    const label = PROVIDER_LABELS[provider] ?? provider;
    sendText(`Connect ${label}: start the OAuth flow with the Connect tool and give me the sign-in link.`);
  };

  const current = sessions.find((s) => s.id === sessionId);
  const connected = status === "open";
  const statusLine = status === "open" ? undefined : status === "connecting" ? "Connecting…" : status === "unauthorized" ? `Rejected: ${statusDetail ?? "bad token"}` : `Offline — retrying (${statusDetail ?? "…"})`;
  const authHeaders = React.useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  // Consecutive agent items (thinking → tools → text) read as one reply: the
  // avatar sits beside the first of the run, the rest hang under it.
  const AGENT = new Set(["assistant", "thinking", "activity", "image"]);
  type Row = { item: Item; first: boolean; lastOfRun: boolean };
  const rows = React.useMemo<Row[]>(() => {
    const list = transcript.items;
    return list.map((item, i) => {
      const prev = list[i - 1];
      const next = list[i + 1];
      const agent = AGENT.has(item.kind);
      return {
        item,
        first: agent && !(prev && AGENT.has(prev.kind)),
        lastOfRun: agent && !(next && AGENT.has(next.kind)),
      };
    }).reverse();
  }, [transcript.items]);

  const renderRow = ({ item: row }: { item: Row }) => {
    const { item } = row;
    switch (item.kind) {
      case "user":
        return (
          <View style={styles.userRow}>
            <View style={styles.userBubble}>
              {item.steer ? <Text style={styles.steerTag}>↪ steer</Text> : null}
              {item.images?.length ? (
                <View style={styles.userImages}>
                  {item.images.map((uri) => <Image key={uri} source={{ uri }} style={styles.userImage} />)}
                </View>
              ) : null}
              {item.text ? <Text style={styles.userText}>{stripSystemNotes(item.text)}</Text> : null}
            </View>
          </View>
        );
      case "assistant":
      case "thinking":
      case "activity":
      case "image": {
        let body: React.ReactNode;
        if (item.kind === "assistant") {
          body = (
            <View style={styles.assistantBubble}>
              <Markdown text={item.text} />
              {item.streaming ? <Animated.Text style={[styles.cursor, { opacity: pulse }]}>▍</Animated.Text> : null}
            </View>
          );
        } else if (item.kind === "thinking") {
          body = <ThinkingBubble text={item.text} streaming={item.streaming} startedAt={item.startedAt} endedAt={item.endedAt} now={now} />;
        } else if (item.kind === "activity") {
          body = <ActivityCard card={item.card} now={now} />;
        } else {
          body = (
            <View style={styles.shotWrap}>
              <Image source={{ uri: `${origin}/gateway/shot?path=${encodeURIComponent(item.path)}`, headers: authHeaders }} style={styles.shot} resizeMode="contain" />
              <Text style={styles.shotLabel}>{item.label}</Text>
            </View>
          );
        }
        return (
          <View style={[styles.agentRow, row.first ? styles.agentRowFirst : null]}>
            <View style={styles.avatarCol}>
              {row.first ? (
                <View style={styles.avatar}><Text style={styles.avatarGlyph}>🜂</Text></View>
              ) : null}
            </View>
            <View style={styles.agentBody}>{body}</View>
          </View>
        );
      }
      case "permission":
        return <View style={styles.fullRow}><PermissionCard toolName={item.toolName} detail={item.detail} reason={item.reason} decision={item.decision} onDecide={(d) => decidePermission(item.id, d)} /></View>;
      case "connect":
        return <View style={styles.fullRow}><ConnectCard provider={item.provider} expired={item.expired} onConnect={() => connect(item.provider)} /></View>;
      case "notice":
        return <Text style={[styles.notice, item.tone === "error" ? { color: theme.bad } : null]}>{item.text}</Text>;
      default:
        return null;
    }
  };

  return (
    <View style={[styles.wrap, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => setPicker(true)} style={styles.headerTitleWrap}>
          <Animated.View style={[styles.headerAvatar, { opacity: pulse }]}><Text style={styles.headerAvatarGlyph}>🜂</Text></Animated.View>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle} numberOfLines={1}>Ares</Text>
            <Text style={styles.headerSub} numberOfLines={1}>
              {transcript.busy ? "working…" : current?.title && current.title !== "untitled session" ? current.title : connected ? "online" : "offline"}
            </Text>
          </View>
          <Text style={styles.headerChevron}>▾</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            setSpeakReplies((v) => !v);
            if (speakReplies) stopSpeaking();
            void Haptics.selectionAsync();
          }}
          style={[styles.headerButton, speakReplies ? styles.headerButtonOn : null]}
        >
          <Text style={styles.headerButtonText}>{speakReplies ? "🔊" : "🔈"}</Text>
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
          data={rows}
          inverted
          keyExtractor={(row) => row.item.key}
          renderItem={renderRow}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
          keyboardDismissMode="interactive"
          ListEmptyComponent={<Text style={styles.empty}>{connected ? "What's next?" : ""}</Text>}
        />
        <View style={{ paddingBottom: insets.bottom }}>
          <Composer
            busy={transcript.busy}
            connected={connected && !!sessionId}
            draft={draft}
            onDraft={setDraft}
            onSend={sendDraft}
            onStop={stop}
            onPickPhoto={() => void pickPhoto()}
            onHoldMicStart={() => void holdMicStart()}
            onHoldMicEnd={() => void holdMicEnd()}
            listening={listening}
          />
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
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border },
  headerTitleWrap: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  headerAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: theme.accentDim, alignItems: "center", justifyContent: "center" },
  headerAvatarGlyph: { color: theme.accent, fontSize: 18 },
  headerTitle: { color: theme.textStrong, fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
  headerSub: { color: theme.muted, fontSize: 12, marginTop: 1 },
  headerChevron: { color: theme.faint, marginRight: 4 },
  headerButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.panel, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.border },
  headerButtonOn: { backgroundColor: theme.accentDim, borderColor: "rgba(255,122,26,0.4)" },
  headerButtonText: { color: theme.text, fontSize: 17 },
  statusBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: theme.panelRaised, paddingHorizontal: 14, paddingVertical: 8 },
  statusText: { color: theme.muted, fontSize: 13, flexShrink: 1 },
  approvals: { padding: 12, gap: 8 },
  body: { flex: 1 },
  list: { paddingHorizontal: 12, paddingVertical: 14 },
  fullRow: { paddingVertical: 4 },
  userRow: { flexDirection: "row", justifyContent: "flex-end", paddingLeft: 48, paddingVertical: 4 },
  userBubble: { maxWidth: "100%", backgroundColor: theme.userBubble, borderWidth: 1, borderColor: theme.userBorder, borderRadius: radius.bubble, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  userText: { color: theme.textStrong, fontSize: 15.5, lineHeight: 22 },
  userImages: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  userImage: { width: 120, height: 120, borderRadius: 10, backgroundColor: theme.panel },
  steerTag: { color: theme.accent, fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
  agentRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingRight: 24 },
  agentRowFirst: { marginTop: 6 },
  avatarCol: { width: 30 },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: theme.accentDim, alignItems: "center", justifyContent: "center", marginTop: 2 },
  avatarGlyph: { color: theme.accent, fontSize: 15 },
  agentBody: { flex: 1 },
  assistantBubble: { backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.border, borderRadius: radius.bubble, borderTopLeftRadius: 6, paddingHorizontal: 14, paddingVertical: 11 },
  cursor: { color: theme.accent, fontSize: 15, marginTop: 2 },
  shotWrap: { gap: 5 },
  shot: { width: "100%", aspectRatio: 16 / 10, borderRadius: radius.card, backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.border },
  shotLabel: { color: theme.faint, fontSize: 12 },
  notice: { color: theme.faint, fontSize: 12.5, textAlign: "center", paddingVertical: 6 },
  empty: { color: theme.faint, textAlign: "center", marginTop: 40, transform: [{ scaleY: -1 }] },
  sessionRow: { backgroundColor: theme.panel, borderRadius: radius.card, borderWidth: 1, borderColor: theme.border, padding: 12, gap: 4 },
  sessionTitle: { color: theme.text, fontSize: 15, fontWeight: "600" },
  sessionMeta: { color: theme.muted, fontSize: 12 },
});
