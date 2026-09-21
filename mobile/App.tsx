import React from "react";
import { ActivityIndicator, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GatewayClient } from "./src/gateway";
import { PairScreen } from "./src/screens/PairScreen";
import { ChatScreen } from "./src/screens/ChatScreen";
import { clearSettings, httpOriginOf, loadSettings, saveSettings, type Settings } from "./src/store";
import { theme } from "./src/theme";

export default function App() {
  const [settings, setSettings] = React.useState<Settings | null | undefined>(undefined);
  const [client, setClient] = React.useState<GatewayClient | null>(null);
  const [pairError, setPairError] = React.useState<string | undefined>();

  React.useEffect(() => {
    void loadSettings().then((loaded) => setSettings(loaded));
  }, []);

  React.useEffect(() => {
    if (!settings) {
      setClient(null);
      return;
    }
    const next = new GatewayClient(settings.url, settings.token);
    const off = next.onStatus((status, detail) => {
      if (status === "unauthorized") setPairError(detail ?? "The garrison rejected that token.");
    });
    next.connect();
    setClient(next);
    return () => {
      off();
      next.close();
    };
  }, [settings?.url, settings?.token]);

  const pair = (url: string, token: string) => {
    setPairError(undefined);
    const next = { url, token };
    void saveSettings(next);
    setSettings(next);
  };

  const forget = () => {
    void clearSettings();
    setSettings(null);
  };

  const rememberSession = (id: string) => {
    if (!settings) return;
    const next = { ...settings, lastSessionId: id };
    void saveSettings(next);
    // Not a state change: the client must not reconnect over a session id.
    settings.lastSessionId = id;
  };

  let body: React.ReactNode;
  if (settings === undefined) {
    body = (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  } else if (!settings || !client || pairError) {
    body = <PairScreen initialUrl={settings?.url} initialToken={settings?.token} error={pairError} onPair={pair} />;
  } else {
    body = (
      <ChatScreen
        client={client}
        origin={httpOriginOf(settings.url)}
        token={settings.token}
        initialSessionId={settings.lastSessionId}
        onSessionChange={rememberSession}
        onForget={forget}
      />
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {body}
    </SafeAreaProvider>
  );
}
