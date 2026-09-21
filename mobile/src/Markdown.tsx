// Markdown-lite for the reply bubble: headings, bullets, fenced and inline
// code, bold, links. Small on purpose — it's what the model actually emits,
// and a phone screen rewards restraint.

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

export function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
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
      blocks.push(<InlineText key={key++} line={heading[2]} style={styles.h} />);
      i += 1;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push(
        <View key={key++} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <View style={{ flex: 1 }}>
            <InlineText line={bullet[1]} />
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
    // A paragraph runs until a blank line or a block opener.
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !/^(```|#{1,6}\s|\s*[-*]\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<InlineText key={key++} line={para.join(" ")} />);
  }
  return <View style={styles.wrap}>{blocks}</View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  p: { color: theme.text, fontSize: 16, lineHeight: 22 },
  h: { fontWeight: "700", fontSize: 17 },
  bold: { fontWeight: "700" },
  link: { color: theme.accent, textDecorationLine: "underline" },
  inlineCode: { fontFamily: "Menlo", backgroundColor: theme.code, color: "#ffd9b8", fontSize: 14 },
  codeBlock: { backgroundColor: theme.code, borderRadius: 8, padding: 10 },
  code: { fontFamily: "Menlo", color: "#e6e9ef", fontSize: 13, lineHeight: 18 },
  bulletRow: { flexDirection: "row", gap: 8 },
  bulletDot: { color: theme.muted, fontSize: 16, lineHeight: 22 },
});
