// One palette, deliberately quiet: near-black ground, two elevations of
// slate, a single ember accent. Everything else is opacity.
export const theme = {
  bg: "#07090c",
  panel: "#12161c",
  panelRaised: "#181d25",
  border: "rgba(255,255,255,0.07)",
  borderStrong: "rgba(255,255,255,0.12)",
  text: "#e8ebf0",
  textStrong: "#ffffff",
  muted: "#8b93a1",
  faint: "#5c6472",
  accent: "#ff7a1a",
  accentDim: "rgba(255,122,26,0.16)",
  accentText: "#ffb87a",
  userBubble: "#2a1c12",
  userBorder: "rgba(255,122,26,0.25)",
  ok: "#3fd18b",
  bad: "#ff5c5c",
  warn: "#f5c542",
  code: "#0b0e12",
  thinking: "#a3abb9",
} as const;

export const radius = { bubble: 18, card: 14, pill: 22 } as const;
