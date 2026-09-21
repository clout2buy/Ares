// The input bar. While a turn is running, Send becomes Steer — the message
// goes INTO the live turn — and a Stop button appears beside it.

import React from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "../theme";

export function Composer({ busy, connected, onSend, onStop }: { busy: boolean; connected: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const [text, setText] = React.useState("");
  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  };
  return (
    <View style={styles.bar}>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder={connected ? (busy ? "Steer it mid-turn…" : "Message Ares") : "Reconnecting…"}
        placeholderTextColor={theme.muted}
        multiline
        editable={connected}
        blurOnSubmit={false}
      />
      {busy ? (
        <Pressable onPress={onStop} style={({ pressed }) => [styles.stop, { opacity: pressed ? 0.6 : 1 }]}>
          <Text style={styles.stopText}>■</Text>
        </Pressable>
      ) : null}
      <Pressable onPress={submit} disabled={!connected || !text.trim()} style={({ pressed }) => [styles.send, { opacity: !connected || !text.trim() ? 0.35 : pressed ? 0.6 : 1 }]}>
        <Text style={styles.sendText}>{busy ? "↪" : "↑"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.bg },
  input: { flex: 1, minHeight: 40, maxHeight: 140, color: theme.text, fontSize: 16, backgroundColor: theme.panel, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: theme.border },
  send: { width: 40, height: 40, borderRadius: 20, backgroundColor: theme.accent, alignItems: "center", justifyContent: "center" },
  sendText: { color: "#1a0d00", fontSize: 20, fontWeight: "800" },
  stop: { width: 40, height: 40, borderRadius: 20, backgroundColor: "#4a1f1f", alignItems: "center", justifyContent: "center" },
  stopText: { color: theme.bad, fontSize: 16, fontWeight: "800" },
});
