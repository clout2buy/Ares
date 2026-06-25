// "What's New" — the update reveal.
//
// Fires once, the first time the app runs on a version the user hasn't seen. It
// reads the living CHANGELOG and shows a premium, non-technical rundown of what
// changed, then remembers the version so it never nags twice.
//
// Trigger logic (deliberate):
//   • Already saw this version  → nothing.
//   • Brand-new install         → silently mark seen, show nothing (they didn't
//                                  "update" — there's nothing they missed).
//   • Returning user, new build → show the reveal.
// A returning user is detected by the presence of the desktop prefs key, so the
// very first time this feature ships, existing users still get the welcome.
//
// Self-contained like UpdateBanner: pure React + localStorage, no native APIs,
// so it also renders in browser DEMO mode. Append `?whatsnew` to the URL to force
// it open for preview/testing.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CHANGELOG, type ChangelogEntry } from "./changelog";

const LASTSEEN_KEY = "ares.whatsNew.lastSeen";
const PREFS_KEY = "ares.desktop.v3"; // existing-user signal (mirrors App.tsx)

// The reveal is driven by CHANGELOG content, not the raw binary version: a silent
// hotfix that bumps the version without a changelog entry won't fire an empty
// modal, and the trigger can never drift from what's actually shown.
const LATEST_VERSION: string = CHANGELOG[0]?.version ?? "";

function readSeen(): string | null {
  try {
    return window.localStorage.getItem(LASTSEEN_KEY);
  } catch {
    return null;
  }
}

function markSeen(version: string): void {
  try {
    window.localStorage.setItem(LASTSEEN_KEY, version);
  } catch {
    /* storage unavailable — worst case the modal shows again next launch */
  }
}

function isReturningUser(seen: string | null): boolean {
  if (seen !== null) return true;
  try {
    return window.localStorage.getItem(PREFS_KEY) !== null;
  } catch {
    return false;
  }
}

function forcedOpen(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("whatsnew");
  } catch {
    return false;
  }
}

// The releases to celebrate: everything newer than what the user last saw. If we
// can't place their last-seen version, we just show the latest entry.
function entriesSince(seen: string | null): ChangelogEntry[] {
  if (!CHANGELOG.length) return [];
  if (!seen) return [CHANGELOG[0]];
  const idx = CHANGELOG.findIndex((e) => e.version === seen);
  if (idx === -1) return [CHANGELOG[0]];
  return CHANGELOG.slice(0, idx);
}

export function WhatsNew(): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const [forced, setForced] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const seen = useMemo(() => readSeen(), []);
  const entries = useMemo(() => entriesSince(seen), [seen]);
  // Re-open on demand (Settings → What's New). Works even for a version already
  // seen — the render below falls back to the latest entry so the popup the user
  // forgot is always one click away.
  useEffect(() => {
    const onShow = (): void => {
      setForced(true);
      setClosing(false);
      setOpen(true);
    };
    window.addEventListener("ares:show-whatsnew", onShow);
    return () => window.removeEventListener("ares:show-whatsnew", onShow);
  }, []);

  useEffect(() => {
    const force = forcedOpen();
    if (force) {
      setOpen(true);
      return;
    }
    if (!LATEST_VERSION || seen === LATEST_VERSION) return; // already celebrated
    if (!isReturningUser(seen)) {
      // Fresh install: there's nothing they "missed". Record and stay quiet.
      markSeen(LATEST_VERSION);
      return;
    }
    if (!entries.length) {
      markSeen(LATEST_VERSION);
      return;
    }
    setOpen(true);
  }, [seen, entries.length]);

  const dismiss = useCallback(() => {
    setClosing(true);
    setForced(false);
    markSeen(LATEST_VERSION);
    // Let the exit animation play before unmounting.
    window.setTimeout(() => setOpen(false), 220);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Focus the dialog itself (not the footer button) so screen readers land in
    // the modal AND the content stays scrolled to the hero — autoFocusing the
    // button scrolls the card to the bottom and hides the title.
    cardRef.current?.focus({ preventScroll: true });
    if (cardRef.current) cardRef.current.scrollTop = 0; // always open at the hero
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismiss]);

  // On a re-open for a version already seen, "since seen" is empty — fall back to
  // the latest entry so there's always something to show.
  const shown = entries.length ? entries : forced && CHANGELOG.length ? [CHANGELOG[0]] : [];
  if (!open || !shown.length) return null;

  const hero = shown[0];
  const older = shown.slice(1);

  return (
    <div
      className={`scrim center wnScrim${closing ? " wnClosing" : ""}`}
      onClick={dismiss}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wnTitle"
    >
      <div className="wnCard" ref={cardRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="wnGlow" aria-hidden="true" />
        <div className="wnMark" aria-hidden="true" />

        <header className="wnHead">
          <div className="wnKicker">
            <span className="wnSpark" aria-hidden="true">✦</span>
            What's new
            <span className="wnVer">v{hero.version}</span>
          </div>
          <h2 id="wnTitle" className="wnTitle">{hero.title}</h2>
          <p className="wnTagline">{hero.tagline}</p>
        </header>

        <ul className="wnList">
          {hero.highlights.map((h, i) => (
            <li
              key={h.title}
              className="wnItem"
              style={{ ["--i" as string]: String(i) }}
            >
              <span className="wnBadge" aria-hidden="true">{h.icon}</span>
              <div className="wnItemBody">
                <div className="wnItemTop">
                  <span className="wnItemTitle">{h.title}</span>
                  {h.tag ? <span className={`wnTag wnTag--${h.tag.toLowerCase()}`}>{h.tag}</span> : null}
                </div>
                <p className="wnItemBlurb">{h.blurb}</p>
              </div>
            </li>
          ))}
        </ul>

        {older.length ? (
          <div className="wnOlder">
            <button className="wnOlderToggle" onClick={() => setShowOlder((v) => !v)}>
              {showOlder ? "Hide" : "Also new since you were away"} ({older.length})
            </button>
            {showOlder ? (
              <div className="wnOlderList">
                {older.map((e) => (
                  <div key={e.version} className="wnOlderEntry">
                    <span className="wnOlderVer">v{e.version}</span>
                    <span className="wnOlderTitle">{e.title}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <footer className="wnFoot">
          <span className="wnStamp">Ares · {hero.date}</span>
          <button className="wnGo" onClick={dismiss} autoFocus>
            Let's go
          </button>
        </footer>
      </div>
    </div>
  );
}
