// Pair the iPhone app with THIS Ares.
//
// Every Ares hosts its own phone gateway (the garrison), so pairing never goes
// through anyone else's server: the QR carries this machine's address and its
// owner token as an ares://pair link, which the app's scanner reads. The card
// is honest about the address — a quick tunnel changes on every restart and a
// LAN address only works at home — so nobody pairs and then silently loses it.

import qrcode from "qrcode-generator";
import { useMemo, useState } from "react";

export interface PhonePairing {
  url: string;
  token: string;
  name: string;
  link: string;
  permanence: "stable" | "tunnel" | "lan";
  advice?: string;
}

export type PhonePairState = { status: "idle" } | { status: "loading" } | { status: "error"; error: string } | { status: "ready"; pairing: PhonePairing };

function qrDataUrl(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 2);
}

const PERMANENCE_LABEL: Record<PhonePairing["permanence"], string> = {
  stable: "Permanent address",
  tunnel: "Temporary address",
  lan: "Home network only",
};

export function PhonePairCard({ state, onPair, onClose }: { state: PhonePairState; onPair: () => void; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const pairing = state.status === "ready" ? state.pairing : null;
  const qr = useMemo(() => (pairing ? qrDataUrl(pairing.link) : ""), [pairing]);

  return (
    <section className="aresosPhone">
      <div className="aresosDevicesHead">
        📱 Your iPhone <span className="aresosDim">(the Ares app pairs straight to this computer, no outside server)</span>
      </div>
      {state.status === "idle" ? (
        <div className="aresosLinkRow">
          <button className="aresosPrimary" onClick={onPair}>Pair iPhone</button>
          <span className="aresosHint">Shows a QR code. Open the Ares app, tap Scan, and point it at the screen.</span>
        </div>
      ) : state.status === "loading" ? (
        <div className="aresosHint">Getting this computer's address…</div>
      ) : state.status === "error" ? (
        <div className="aresosWarn">
          ⚠ {state.error}
          <div className="aresosLinkRow">
            <button className="aresosGhost aresosSm" onClick={onPair}>Try again</button>
          </div>
        </div>
      ) : pairing ? (
        <div className="aresosLink aresosPhoneCard">
          <div className="aresosLinkTop">
            <b>Scan with the Ares app</b>
            <button className="aresosX" onClick={onClose} title="Hide the code">✕</button>
          </div>
          <div className="aresosPhoneBody">
            <img className="aresosPhoneQr" src={qr} alt="Pairing QR code for the Ares iPhone app" />
            <div className="aresosPhoneInfo">
              <div className={`aresosScope ${pairing.permanence === "stable" ? "ok" : "warn"}`}>{PERMANENCE_LABEL[pairing.permanence]}</div>
              <div className="aresosMeta">Name: <b>{pairing.name}</b></div>
              <div className="aresosMeta">Address</div>
              <div className="aresosLinkUrl">{pairing.url}</div>
              <div className="aresosMeta">Token</div>
              <div className="aresosLinkUrl">
                {showToken ? pairing.token : "•".repeat(Math.min(24, pairing.token.length))}{" "}
                <button className="aresosGhost aresosSm" onClick={() => setShowToken((v) => !v)}>{showToken ? "Hide" : "Show"}</button>
              </div>
              <div className="aresosLinkRow">
                <button
                  className="aresosPair"
                  onClick={() => { void navigator.clipboard.writeText(pairing.link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }); }}
                >{copied ? "✓ Copied" : "⎘ Copy pairing link"}</button>
              </div>
            </div>
          </div>
          {pairing.advice ? <div className="aresosWarn">⚠ {pairing.advice}</div> : null}
          <div className="aresosPairNote">
            The code holds your owner token: anyone who scans it controls this Ares. Close it when you are done.
          </div>
        </div>
      ) : null}
    </section>
  );
}
