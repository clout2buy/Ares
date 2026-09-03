// Near-duplicate text similarity + the low-signal utterance gate (memory hygiene).
//
// Raw user turns used to land in Living Memory on the ungated "manual" channel:
// "fix the login bug" and "fix the login bug please" became two nodes, "ok" and
// "thanks" became nodes, and the store filled with chatter that consolidation
// could only prune by decay. Both helpers here are pure so the router can gate
// on them without I/O and tests can pin the thresholds.

import { jaccard, tokenizeSalient } from "./idf.js";

/** Lowercase, strip punctuation, collapse whitespace — the comparison form. */
export function normalizeUtterance(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < text.length; i++) out.add(text.slice(i, i + 2));
  return out;
}

/**
 * 0..1 similarity of two utterances. The max of a character-bigram Dice
 * coefficient (robust to a trailing "please" or a typo) and salient-token
 * jaccard (robust to reordering), over normalized text. 1 = identical after
 * normalization.
 */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeUtterance(a);
  const nb = normalizeUtterance(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  const dice = ba.size + bb.size === 0 ? 0 : (2 * inter) / (ba.size + bb.size);
  const tj = jaccard(new Set(tokenizeSalient(na)), new Set(tokenizeSalient(nb)));
  return Math.max(dice, tj);
}

// Words that, on their own or in any combination, carry no durable signal.
const ACK_TOKENS = new Set([
  "hi", "hey", "hello", "yo", "sup", "hiya", "howdy", "morning", "evening", "night",
  "thanks", "thank", "thx", "ty", "cheers", "appreciate", "appreciated",
  "ok", "okay", "k", "kk", "oki", "cool", "nice", "great", "good", "sure", "fine", "alright", "right",
  "yes", "yep", "yeah", "yup", "no", "nope", "nah", "lol", "lmao", "haha", "bet", "word", "true", "facts",
  "got", "it", "sounds", "will", "do", "np", "problem", "perfect", "awesome", "done", "noted", "understood",
  "you", "u", "bro", "man", "dude", "homie", "ares", "so", "much", "a", "lot", "that", "is", "very", "the",
  "please", "pls", "plz", "later", "bye", "cya", "gn", "gm", "wyd", "what's", "whats", "up", "there", "all", "everyone",
]);

/**
 * True for greetings, acks, "ok"/"thanks" combos, and one-word messages —
 * anything not worth an episodic node. A single non-ack word ("deploy") is
 * still low signal: one word is a label, not an episode.
 */
export function isLowSignalUtterance(text: string): boolean {
  const words = normalizeUtterance(text).split(" ").filter(Boolean);
  if (words.length <= 1) return true;
  return words.every((w) => ACK_TOKENS.has(w));
}
