import React from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GatewayClient } from "./src/gateway";
import { PairScreen } from "./src/screens/PairScreen";
import { ChatScreen } from "./src/screens/ChatScreen";
import { InstancesScreen, type Presence } from "./src/screens/InstancesScreen";
import { PROFILE_COLORS, activeProfile, httpOriginOf, loadSettings, nameFromUrl, newProfileId, saveSettings, type Profile, type Settings } from "./src/store";
import { theme } from "./src/theme";
import { watchForUpdates } from "./src/updates";

type Screen = "list" | "chat" | "pair";

export default function App() {
  const [settings, setSettings] = React.useState<Settings | undefined>(undefined);
  const [screen, setScreen] = React.useState<Screen>("list");
  const [client, setClient] = React.useState<GatewayClient | null>(null);
  const [pairError, setPairError] = React.useState<string | undefined>();
  const [presence, setPresence] = React.useState<Record<string, Presence>>({});

  React.useEffect(() => {
    void loadSettings().then((loaded) => {
      setSettings(loaded);
      // One instance → straight into it, like a one-contact Messages.
      setScreen(loaded.profiles.length === 0 ? "pair" : loaded.profiles.length === 1 ? "chat" : "list");
    });
    return watchForUpdates();
  }, []);

  const active = settings ? activeProfile(settings) : undefined;

  // The active instance keeps a live socket; the rest are probed for presence.
  React.useEffect(() => {
    if (!active || screen !== "chat") {
      setClient(null);
      return;
    }
    const next = new GatewayClient(active.url, active.token);
    const off = next.onStatus((status, detail) => {
      if (status === "unauthorized") setPairError(detail ?? "The garrison rejected that token.");
      if (status === "open") setPresence((p) => ({ ...p, [active.id]: "online" }));
      if (status === "closed") setPresence((p) => ({ ...p, [active.id]: "offline" }));
    });
    next.connect();
    setClient(next);
    return () => {
      off();
      next.close();
    };
  }, [active?.id, active?.url, active?.token, screen]);

  // On the list, ping every instance's health once so the dots mean something.
  React.useEffect(() => {
    if (screen !== "list" || !settings) return;
    let cancelled = false;
    for (const p of settings.profiles) {
      setPresence((s) => ({ ...s, [p.id]: s[p.id] ?? "checking" }));
      fetch(`${httpOriginOf(p.url)}/gateway/health`, { signal: AbortSignal.timeout(6000) })
        .then((r) => r.ok)
        .catch(() => false)
        .then((ok) => {
          if (!cancelled) setPresence((s) => ({ ...s, [p.id]: ok ? "online" : "offline" }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [screen, settings?.profiles.length]);

  const persist = (next: Settings) => {
    setSettings(next);
    void saveSettings(next);
  };

  const pair = (url: string, token: string, name?: string) => {
    if (!settings) return;
    setPairError(undefined);
    const profile: Profile = {
      id: newProfileId(),
      name: name?.trim() || nameFromUrl(url),
      url,
      token,
      color: PROFILE_COLORS[settings.profiles.length % PROFILE_COLORS.length],
      lastSeenAt: Date.now(),
    };
    persist({ profiles: [...settings.profiles, profile], activeId: profile.id });
    setScreen("chat");
  };

  const open = (p: Profile) => {
    if (!settings) return;
    persist({ ...settings, activeId: p.id, profiles: settings.profiles.map((x) => (x.id === p.id ? { ...x, lastSeenAt: Date.now() } : x)) });
    setPairError(undefined);
    setScreen("chat");
  };

  const rememberSession = (id: string) => {
    if (!settings || !active) return;
    persist({ ...settings, profiles: settings.profiles.map((x) => (x.id === active.id ? { ...x, lastSessionId: id } : x)) });
  };

  const forget = (p: Profile) => {
    if (!settings) return;
    const profiles = settings.profiles.filter((x) => x.id !== p.id);
    persist({ profiles, activeId: profiles[0]?.id });
    setPairError(undefined);
    setScreen(profiles.length === 0 ? "pair" : "list");
  };

  const manage = (p: Profile) => {
    Alert.alert(p.name, new URL(p.url).hostname, [
      { text: "Open", onPress: () => open(p) },
      { text: "Forget", style: "destructive", onPress: () => forget(p) },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  let body: React.ReactNode;
  if (settings === undefined) {
    body = (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  } else if (screen === "pair" || (screen === "chat" && (!active || pairError))) {
    body = (
      <PairScreen
        initialUrl={pairError ? active?.url : undefined}
        initialToken={pairError ? active?.token : undefined}
        error={pairError}
        canCancel={settings.profiles.length > 0}
        onCancel={() => { setPairError(undefined); setScreen(settings.profiles.length === 1 ? "chat" : "list"); }}
        onPair={pair}
      />
    );
  } else if (screen === "list" || !client || !active) {
    body = <InstancesScreen profiles={settings.profiles} presence={presence} onOpen={open} onAdd={() => setScreen("pair")} onLongPress={manage} />;
  } else {
    body = (
      <ChatScreen
        key={active.id}
        client={client}
        origin={httpOriginOf(active.url)}
        token={active.token}
        instanceName={active.name}
        instanceColor={active.color}
        initialSessionId={active.lastSessionId}
        onSessionChange={rememberSession}
        onBack={() => setScreen("list")}
        onForget={() => forget(active)}
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
