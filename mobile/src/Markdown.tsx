// Markdown-lite for the reply bubble: headings, bullets, fenced and inline
// code, bold, links. Typography tuned for a phone: 15.5/22 body, real
// hierarchy, code that reads as code.

import React from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { theme } from "./theme";

type Inline = { kind: "text"; text: string } | { kind: "code"; text: string } | { kind: "bold"; text: string } | { kind: "link"; text: string; href: string };

function inlines(line: string): Inline[] {
  const out: Inline[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)]+)/g;
  let at = 0;
  for (const m of line.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > at) out.push({ kind: "text", text: line.slice(at, i) });
    if (m[1]) out.push({ kind: "code", text: m[1].slice(1, -1) });
    else if (m[2]) out.push({ kind: "bold", text: m[2].slice(2, -2) });
    else if (m[3]) out.push({ kind: "link", text: m[3].slice(1, m[3].indexOf("]")), href: m[4] });
    else if (m[5]) out.push({ kind: "link", text: m[5], href: m[5] });
    at = i + m[0].length;
  }
  if (at < line.length) out.push({ kind: "text", text: line.slice(at) });
  return out;
}

function InlineText({ line, style }: { line: string; style?: object }) {
  return (
    <Text style={[styles.p, style]}>
      {inlines(line).map((part, i) => {
        if (part.kind === "code") return <Text key={i} style={styles.inlineCode}>{part.text}</Text>;
        if (part.kind === "bold") return <Text key={i} style={styles.bold}>{part.text}</Text>;
        if (part.kind === "link")
          return (
            <Text key={i} style={styles.link} onPress={() => void Linking.openURL(part.href)}>
              {part.text}
            </Text>
          );
        return <Text key={i}>{part.text}</Text>;
      })}
    </Text>
  );
}

export function Markdown({ text, muted = false }: { text: string; muted?: boolean }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const base = muted ? styles.mutedText : undefined;
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i += 1;
      blocks.push(
        <View key={key++} style={styles.codeBlock}>
          <Text style={styles.code}>{code.join("\n")}</Text>
        </View>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<InlineText key={key++} line={heading[2]} style={[styles.h, base]} />);
      i += 1;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push(
        <View key={key++} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <View style={{ flex: 1 }}>
            <InlineText line={bullet[1]} style={base} />
          </View>
        </View>,
      );
      i += 1;
      continue;
    }
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      blocks.push(
        <View key={key++} style={styles.bulletRow}>
          <Text style={styles.bulletNum}>{numbered[1]}.</Text>
          <View style={{ flex: 1 }}>
            <InlineText line={numbered[2]} style={base} />
          </View>
        </View>,
      );
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !/^(```|#{1,6}\s|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<InlineText key={key++} line={para.join(" ")} style={base} />);
  }
  return <View style={styles.wrap}>{blocks}</View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 9 },
  p: { color: theme.text, fontSize: 15.5, lineHeight: 22.5, letterSpacing: -0.1 },
  mutedText: { color: theme.thinking, fontStyle: "italic" },
  h: { fontWeight: "700", fontSize: 16.5, color: theme.textStrong, marginTop: 2 },
  bold: { fontWeight: "600", color: theme.textStrong },
  link: { color: theme.accentText, textDecorationLine: "underline" },
  inlineCode: { fontFamily: "Menlo", backgroundColor: theme.code, color: theme.accentText, fontSize: 13.5, borderRadius: 4 },
  codeBlock: { backgroundColor: theme.code, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: theme.border },
  code: { fontFamily: "Menlo", color: theme.text, fontSize: 13, lineHeight: 18.5 },
  bulletRow: { flexDirection: "row", gap: 9, paddingLeft: 2 },
  bulletDot: { color: theme.accent, fontSize: 15.5, lineHeight: 22.5 },
  bulletNum: { color: theme.muted, fontSize: 14.5, lineHeight: 22.5, minWidth: 18 },
});
