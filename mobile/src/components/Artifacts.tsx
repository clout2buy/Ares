// The things Ares makes, shown instead of described: an image inline, a page
// (WebGL, a report) as a card that opens in an in-app viewer.

import React from "react";
import { Animated, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, theme } from "../theme";

export function ArtifactCard({ path, name, media, origin, headers, onOpen }: { path: string; name: string; media: "html" | "image" | "file"; origin: string; headers: Record<string, string>; onOpen: () => void }) {
  const uri = `${origin}/gateway/file?path=${encodeURIComponent(path)}`;
  if (media === "image") {
    return (
      <Pressable onPress={onOpen} style={styles.imageWrap}>
        <Image source={{ uri, headers }} style={styles.image} resizeMode="cover" />
        <Text style={styles.caption}>{name}</Text>
      </Pressable>
    );
  }
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => [styles.card, { opacity: pressed ? 0.8 : 1 }]}>
      <View style={styles.iconWrap}><Text style={styles.icon}>{media === "html" ? "◈" : "▤"}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.name} numberOfLines={1}>{name}</Text>
        <Text style={styles.sub} numberOfLines={1}>{media === "html" ? "Interactive page · tap to open" : "File · tap to open"}</Text>
      </View>
      <Text style={styles.open}>Open ›</Text>
    </Pressable>
  );
}

/** Full-screen viewer. HTML runs with scripts (WebGL, canvas) but the server
 *  hands it a CSP with no network, so a page Ares wrote can draw, not dial. */
export function ArtifactViewer({ path, name, origin, headers, onClose }: { path: string | null; name: string; origin: string; headers: Record<string, string>; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  if (!path) return null;
  const uri = `${origin}/gateway/file?path=${encodeURIComponent(path)}`;
  const isImage = /\.(png|jpe?g|webp|gif|svg)$/i.test(path);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={[styles.viewer, { paddingTop: insets.top }]}>
        <View style={styles.viewerBar}>
          <Text style={styles.viewerTitle} numberOfLines={1}>{name}</Text>
          <Pressable onPress={onClose} style={styles.close}><Text style={styles.closeText}>✕</Text></Pressable>
        </View>
        {isImage ? (
          <Image source={{ uri, headers }} style={styles.viewerImage} resizeMode="contain" />
        ) : (
          <WebView
            source={{ uri, headers }}
            style={styles.web}
            javaScriptEnabled
            allowsInlineMediaPlayback
            originWhitelist={["*"]}
            startInLoadingState
            renderLoading={() => <View style={styles.loading}><Text style={styles.loadingText}>Loading…</Text></View>}
          />
        )}
      </View>
    </Modal>
  );
}

/** Slides a new row in — the difference between a log and a conversation. */
export function Enter({ children }: { children: React.ReactNode }) {
  const a = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    Animated.spring(a, { toValue: 1, useNativeDriver: true, damping: 18, stiffness: 180, mass: 0.8 }).start();
  }, [a]);
  return (
    <Animated.View style={{ opacity: a, transform: [{ translateY: Animated.multiply(Animated.subtract(1, a), 10) }] }}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  imageWrap: { gap: 5 },
  image: { width: "100%", aspectRatio: 16 / 10, borderRadius: radius.card, backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.border },
  caption: { color: theme.faint, fontSize: 12 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: theme.panel, borderWidth: 1, borderColor: theme.borderStrong, borderRadius: radius.card, padding: 12 },
  iconWrap: { width: 40, height: 40, borderRadius: 10, backgroundColor: theme.accentDim, alignItems: "center", justifyContent: "center" },
  icon: { color: theme.accent, fontSize: 20 },
  name: { color: theme.textStrong, fontSize: 14.5, fontWeight: "600" },
  sub: { color: theme.muted, fontSize: 12.5, marginTop: 1 },
  open: { color: theme.accent, fontSize: 13.5, fontWeight: "600" },
  viewer: { flex: 1, backgroundColor: "#000" },
  viewerBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, gap: 10, borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: theme.bg },
  viewerTitle: { flex: 1, color: theme.textStrong, fontSize: 15, fontWeight: "600" },
  close: { width: 34, height: 34, borderRadius: 17, backgroundColor: theme.panel, alignItems: "center", justifyContent: "center" },
  closeText: { color: theme.text, fontSize: 15 },
  viewerImage: { flex: 1, width: "100%" },
  web: { flex: 1, backgroundColor: "#000" },
  loading: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: "#000" },
  loadingText: { color: theme.muted },
});
