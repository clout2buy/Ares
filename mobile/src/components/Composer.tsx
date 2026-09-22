// The input bar: a pill, a mic you hold, a photo button, and Send — which
// becomes Steer while a turn runs, with Stop beside it.

import React from "react";
import { Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { radius, theme } from "../theme";

export interface Draft {
  text: string;
  images: Array<{ uri: string; base64: string; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }>;
}

export function Composer({ busy, connected, draft, onDraft, onSend, onStop, onPickPhoto, onHoldMicStart, onHoldMicEnd, listening }: {
  busy: boolean; connected: boolean; draft: Draft; onDraft: (next: Draft) => void; onSend: () => void; onStop: () => void;
  onPickPhoto: () => void; onHoldMicStart: () => void; onHoldMicEnd: () => void; listening: boolean;
}) {
  const canSend = connected && (draft.text.trim().length > 0 || draft.images.length > 0);
  return (
    <View style={styles.wrap}>
      {draft.images.length > 0 ? (
        <View style={styles.thumbs}>
          {draft.images.map((img, i) => (
            <Pressable key={img.uri + i} onPress={() => onDraft({ ...draft, images: draft.images.filter((_, j) => j !== i) })}>
              <Image source={{ uri: img.uri }} style={styles.thumb} />
              <View style={styles.thumbX}><Text style={styles.thumbXText}>✕</Text></View>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.bar}>
        <Pressable onPress={onPickPhoto} disabled={!connected} style={({ pressed }) => [styles.icon, { opacity: !connected ? 0.35 : pressed ? 0.6 : 1 }]}>
          <Text style={styles.iconText}>＋</Text>
        </Pressable>
        <View style={[styles.pill, listening ? styles.pillLive : null]}>
          <TextInput
            style={styles.input}
            value={draft.text}
            onChangeText={(text) => onDraft({ ...draft, text })}
            placeholder={listening ? "Listening…" : connected ? (busy ? "Steer it mid-turn…" : "Message Ares") : "Reconnecting…"}
            placeholderTextColor={listening ? theme.accent : theme.faint}
            multiline
            editable={connected}
          />
          <Pressable onPressIn={onHoldMicStart} onPressOut={onHoldMicEnd} disabled={!connected} style={({ pressed }) => [styles.mic, listening || pressed ? styles.micLive : null]}>
            <Text style={[styles.micText, listening ? { color: "#1a0d00" } : null]}>🎙</Text>
          </Pressable>
        </View>
        {busy ? (
          <Pressable onPress={onStop} style={({ pressed }) => [styles.icon, styles.stop, { opacity: pressed ? 0.6 : 1 }]}>
            <View style={styles.stopSquare} />
          </Pressable>
        ) : null}
        <Pressable onPress={onSend} disabled={!canSend} style={({ pressed }) => [styles.icon, styles.send, { opacity: !canSend ? 0.3 : pressed ? 0.7 : 1 }]}>
          <Text style={styles.sendText}>{busy ? "↪" : "↑"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.bg },
  thumbs: { flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingTop: 10 },
  thumb: { width: 60, height: 60, borderRadius: 10, backgroundColor: theme.panel },
  thumbX: { position: "absolute", top: -5, right: -5, backgroundColor: theme.panelRaised, borderRadius: 9, width: 18, height: 18, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.borderStrong },
  thumbXText: { color: theme.text, fontSize: 10 },
  bar: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 10, paddingVertical: 10 },
  pill: { flex: 1, flexDirection: "row", alignItems: "flex-end", backgroundColor: theme.panelRaised, borderRadius: radius.pill, borderWidth: 1, borderColor: theme.border, paddingLeft: 14, paddingRight: 4, paddingVertical: 3, minHeight: 44 },
  pillLive: { borderColor: theme.accent },
  input: { flex: 1, maxHeight: 140, color: theme.text, fontSize: 16, lineHeight: 21, paddingVertical: 8 },
  mic: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", marginBottom: 1 },
  micLive: { backgroundColor: theme.accent },
  micText: { fontSize: 17 },
  icon: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.panelRaised, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.border },
  iconText: { color: theme.text, fontSize: 22, marginTop: -2 },
  send: { backgroundColor: theme.accent, borderColor: theme.accent },
  sendText: { color: "#1a0d00", fontSize: 20, fontWeight: "800" },
  stop: { backgroundColor: "rgba(255,92,92,0.14)", borderColor: "rgba(255,92,92,0.35)" },
  stopSquare: { width: 14, height: 14, borderRadius: 3, backgroundColor: theme.bad },
});
