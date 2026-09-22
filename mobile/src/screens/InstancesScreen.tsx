// Home: every Ares you've paired, as a contact list. Each row is one
// instance — its color, name, where it lives, whether it's answering right
// now — and tapping it opens that instance's chat.

import React from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, theme } from "../theme";
import type { Profile } from "../store";

export type Presence = "online" | "offline" | "checking";

function ago(at?: number): string {
  if (!at) return "never";
  const min = Math.floor((Date.now() - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function InstancesScreen({ profiles, presence, onOpen, onAdd, onLongPress }: { profiles: Profile[]; presence: Record<string, Presence>; onOpen: (p: Profile) => void; onAdd: () => void; onLongPress: (p: Profile) => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Ares</Text>
        <Pressable onPress={onAdd} style={styles.add}><Text style={styles.addText}>＋</Text></Pressable>
      </View>
      <Text style={styles.sub}>{profiles.length} instance{profiles.length === 1 ? "" : "s"}</Text>
      <FlatList
        data={profiles}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        renderItem={({ item }) => {
          const state = presence[item.id] ?? "checking";
          const dot = state === "online" ? theme.ok : state === "offline" ? theme.faint : theme.warn;
          return (
            <Pressable onPress={() => onOpen(item)} onLongPress={() => onLongPress(item)} style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}>
              <View style={[styles.avatar, { backgroundColor: `${item.color}26` }]}>
                <Text style={[styles.glyph, { color: item.color }]}>🜂</Text>
                <View style={[styles.dot, { backgroundColor: dot }]} />
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.rowTop}>
                  <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.when}>{ago(item.lastSeenAt)}</Text>
                </View>
                <Text style={styles.host} numberOfLines={1}>
                  {state === "online" ? "online" : state === "offline" ? "unreachable" : "connecting…"} · {hostOf(item.url)}
                </Text>
              </View>
              <Text style={styles.chev}>›</Text>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyGlyph}>🜂</Text>
            <Text style={styles.emptyText}>No instances yet.</Text>
            <Text style={styles.emptySub}>Pair your first Ares with ＋</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, paddingTop: 8 },
  title: { color: theme.textStrong, fontSize: 32, fontWeight: "800", letterSpacing: -0.6 },
  sub: { color: theme.muted, fontSize: 13, paddingHorizontal: 18, marginTop: 2, marginBottom: 8 },
  add: { width: 38, height: 38, borderRadius: 19, backgroundColor: theme.accent, alignItems: "center", justifyContent: "center" },
  addText: { color: "#1a0d00", fontSize: 24, marginTop: -2, fontWeight: "700" },
  list: { paddingHorizontal: 12, paddingBottom: 24 },
  sep: { height: 1, backgroundColor: theme.border, marginLeft: 70 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 6 },
  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  glyph: { fontSize: 22 },
  dot: { position: "absolute", right: 0, bottom: 0, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: theme.bg },
  rowTop: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  name: { color: theme.textStrong, fontSize: 16.5, fontWeight: "600", flexShrink: 1 },
  when: { color: theme.faint, fontSize: 12 },
  host: { color: theme.muted, fontSize: 13, marginTop: 2 },
  chev: { color: theme.faint, fontSize: 22 },
  empty: { alignItems: "center", paddingTop: 80, gap: 6 },
  emptyGlyph: { color: theme.accent, fontSize: 40 },
  emptyText: { color: theme.text, fontSize: 16, fontWeight: "600" },
  emptySub: { color: theme.muted, fontSize: 13 },
});
