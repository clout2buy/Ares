// GenUI's face: the whole-window arrival, the toggle's greeting card. Motion
// only (a ring opening, the shell settling); nothing here flashes.

import React from "react";
import { useSurfaces } from "./SurfacesContext";

export function GenuiFx({ phase }: { phase: "on" | "off" }) {
  return (
    <div className="genuiFx" data-phase={phase} aria-hidden="true">
      <i className="genuiRing" />
      <div className="genuiWord">
        <strong>GenUI</strong>
        <span>{phase === "on" ? "Ares can change itself, live." : "Ares is locked to what exists."}</span>
      </div>
    </div>
  );
}

const IDEAS = [
  "Add a button to the left bar",
  "Open a panel on each side and connect them",
  "Rebuild this layout for me",
];

export function GenuiCard({ name }: { name: string }) {
  const { say } = useSurfaces();
  return (
    <div className="genuiCard">
      <strong>GenUI enabled</strong>
      <p>{name} can now change anything in Ares and you will see it happen. What should we expand, edit, improve or add?</p>
      <div className="genuiIdeas">
        {IDEAS.map((idea) => <button key={idea} onClick={() => say(idea)}>{idea}</button>)}
      </div>
    </div>
  );
}
