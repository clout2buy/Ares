// Pairing: where the garrison is and the token that opens it. Scan the QR
// the box prints, or type both in.

import React from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Button } from "../components/Cards";
import { normalizeGatewayUrl, parsePairPayload } from "../store";
import { theme } from "../theme";

export function PairScreen({ initialUrl, initialToken, error, canCancel, onCancel, onPair }: { initialUrl?: string; initialToken?: string; error?: string; canCancel?: boolean; onCancel?: () => void; onPair: (url: string, token: string, name?: string) => void }) {
  const [url, setUrl] = React.useState(initialUrl ?? "");
  const [token, setToken] = React.useState(initialToken ?? "");
  const [name, setName] = React.useState("");
  const [scanning, setScanning] = React.useState(false);
  const [problem, setProblem] = React.useState<string | undefined>();
  const [permission, requestPermission] = useCameraPermissions();

  const submit = () => {
    const normalized = normalizeGatewayUrl(url);
    if (!normalized) return setProblem("That doesn't look like a gateway address (ares.example.com or wss://…/gateway).");
    if (!token.trim()) return setProblem("The token is in ~/.ares/garrison/token on the box.");
    setProblem(undefined);
    onPair(normalized, token.trim(), name);
  };

  const startScan = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) return setProblem("Camera permission is needed to scan the pairing QR.");
    }
    setScanning(true);
  };

  if (scanning) {
    return (
      <View style={styles.scanWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            const pair = parsePairPayload(data);
            if (!pair) return;
            setScanning(false);
            setUrl(pair.url);
            setToken(pair.token);
            onPair(pair.url, pair.token, pair.name ?? name);
          }}
        />
        <View style={styles.scanFooter}>
          <Text style={styles.scanHint}>Point at the pairing QR</Text>
          <Button label="Cancel" tone="muted" onPress={() => setScanning(false)} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.wrap} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.glyph}>🜂</Text>
        <Text style={styles.title}>Ares</Text>
        <Text style={styles.sub}>Pair an Ares instance.</Text>

        <Text style={styles.label}>Name</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="doingbox, laptop, …  (optional)" placeholderTextColor={theme.muted} autoCorrect={false} />
        <Text style={styles.label}>Gateway</Text>
        <TextInput style={styles.input} value={url} onChangeText={setUrl} placeholder="ares.mistiqueai.com" placeholderTextColor={theme.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        <Text style={styles.label}>Token</Text>
        <TextInput style={styles.input} value={token} onChangeText={setToken} placeholder="from ~/.ares/garrison/token" placeholderTextColor={theme.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry />

        {problem || error ? <Text style={styles.error}>{problem ?? error}</Text> : null}

        <View style={styles.buttons}>
          <Button label="Connect" onPress={submit} />
          <Button label="Scan QR" tone="muted" onPress={() => void startScan()} />
          {canCancel && onCancel ? <Button label="Cancel" tone="muted" onPress={onCancel} /> : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: 24, paddingTop: 80, gap: 10 },
  glyph: { fontSize: 44, color: theme.accent, textAlign: "center" },
  title: { color: theme.text, fontSize: 30, fontWeight: "800", textAlign: "center" },
  sub: { color: theme.muted, textAlign: "center", marginBottom: 20 },
  label: { color: theme.muted, fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginTop: 8 },
  input: { color: theme.text, fontSize: 16, backgroundColor: theme.panel, borderRadius: 10, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, paddingVertical: 12 },
  error: { color: theme.bad, marginTop: 8 },
  buttons: { flexDirection: "row", gap: 10, marginTop: 20 },
  scanWrap: { flex: 1, backgroundColor: "#000" },
  scanFooter: { position: "absolute", bottom: 40, left: 0, right: 0, alignItems: "center", gap: 12 },
  scanHint: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
