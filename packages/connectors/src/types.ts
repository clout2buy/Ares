// The vendor-neutral browser interface (Ares v5 / O6 / concept C6).
//
// Ares owns this interface; the engine (Playwright, Chrome MCP, …) is a
// swappable adapter. DOM-first by design — find elements by role/label from the
// accessibility tree (precise, robust) and fall to pixels/vision only when
// structure can't express the target. Every adapter implements this same shape,
// so the rest of Ares never knows or cares which browser is underneath.

export interface AccessibilityNode {
  role: string;
  name?: string;
  /** A stable handle the connector can act on (label, role+name, or selector). */
  selector: string;
}

export interface Screenshot {
  format: "png";
  /** base64-encoded image bytes. */
  bytes: string;
  width?: number;
  height?: number;
}

export interface BrowserState {
  url: string;
  title?: string;
}

export interface BrowserConnector {
  readonly name: string;
  navigate(url: string): Promise<BrowserState>;
  /** DOM-first targeting: the structured tree, preferred over pixels. */
  accessibilityTree(): Promise<AccessibilityNode[]>;
  fillByLabel(label: string, value: string): Promise<void>;
  clickByRole(role: string, name: string): Promise<void>;
  screenshot(): Promise<Screenshot>;
  state(): Promise<BrowserState>;
  close(): Promise<void>;
}
