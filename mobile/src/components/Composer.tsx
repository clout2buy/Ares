// The input bar. While a turn is running, Send becomes Steer — the message
// goes INTO the live turn — and a Stop button appears. Hold the mic to talk;
// the photo button attaches images the model can see.

import React from "react";
import { Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../theme";

export interface Draft {
  text: string;
  images: Array<{ uri: string; base64: string; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }>;
}

export function Composer({
  busy,
  connected,
  draft,
  onDraft,
  onSend,
  onStop,
  onPickPhoto,
  onHoldMicStart,
  onHoldMicEnd,
  listening,
}: {
  busy: boolean;
  connected: boolean;
  draft: Draft;
  onDraft: (next: Draft) => void;
  onSend: () => void;
  onStop: () => void;
  onPickPhoto: () => void;
  onHoldMicStart: () => void;
  onHoldMicEnd: () => void;
  listening: boolean;
}) {
  const canSend = connected && (draft.text.trim().length > 0 || draft.images.length > 0);
  return (
    <View style={styles.wrap}>
      {draft.images.length > 0 ? (
        <View style={styles.thumbs}>
          {draft.images.map((img, i) => (
            <Pressable key={img.uri + i} onPress={() => onDraft({ ...draft, images: draft.images.filter((_, j) => j !== i) })}>
              <Image source={{ uri: img.uri }} style={styles.thumb} />
              <Text style={styles.thumbX}>✕</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.bar}>
        <Pressable onPress={onPickPhoto} disabled={!connected} style={({ pressed }) => [styles.round, { opacity: !connected ? 0.35 : pressed ? 0.6 : 1 }]}>
          <Text style={styles.roundText}>＋</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          value={draft.text}
          onChangeText={(text) => onDraft({ ...draft, text })}
          placeholder={listening ? "Listening…" : connected ? (busy ? "Steer it mid-turn…" : "Message Ares") : "Reconnecting…"}
          placeholderTextColor={listening ? theme.accent : theme.muted}
          multiline
          editable={connected}
        />
        <Pressable
          onPressIn={onHoldMicStart}
          onPressOut={onHoldMicEnd}
          disabled={!connected}
          style={({ pressed }) => [styles.round, listening || pressed ? styles.roundLive : null, { opacity: !connected ? 0.35 : 1 }]}
        >
          <Text style={[styles.roundText, listening ? { color: "#1a0d00" } : null]}>🎙</Text>
        </Pressable>
        {busy ? (
          <Pressable onPress={onStop} style={({ pressed }) => [styles.round, styles.stop, { opacity: pressed ? 0.6 : 1 }]}>
            <Text style={styles.stopText}>■</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onSend} disabled={!canSend} style={({ pressed }) => [styles.round, styles.send, { opacity: !canSend ? 0.35 : pressed ? 0.6 : 1 }]}>
          <Text style={styles.sendText}>{busy ? "↪" : "↑"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.bg },
  thumbs: { flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingTop: 10 },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: theme.panel },
  thumbX: { position: "absolute", top: -6, right: -6, color: theme.text, backgroundColor: theme.panelRaised, borderRadius: 9, width: 18, height: 18, textAlign: "center", fontSize: 11, lineHeight: 18, overflow: "hidden" },
  bar: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 10 },
  input: { flex: 1, minHeight: 40, maxHeight: 140, color: theme.text, fontSize: 16, backgroundColor: theme.panel, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: theme.border },
  round: { width: 40, height: 40, borderRadius: 20, backgroundColor: theme.panel, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.border },
  roundLive: { backgroundColor: theme.accent, borderColor: theme.accent },
  roundText: { color: theme.text, fontSize: 18 },
  send: { backgroundColor: theme.accent, borderColor: theme.accent },
  sendText: { color: "#1a0d00", fontSize: 20, fontWeight: "800" },
  stop: { backgroundColor: "#4a1f1f", borderColor: "#4a1f1f" },
  stopText: { color: theme.bad, fontSize: 16, fontWeight: "800" },
});
