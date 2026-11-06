// What a surface document may contain before it is framed. The daemon refused
// the worst already (frames, external URLs, flashing); this is the render-time
// floor the desktop keeps regardless of what the ledger says, because the
// ledger is a directory a person can edit.

/* Scripts are a designed capability (the iframe runs them at an OPAQUE origin
 * with no parent access, and its CSP forbids every network request), so the
 * sanitizer's remaining jobs are: no nested browsing contexts, no
 * document-level directives, and no external references. */
const FORBIDDEN_ELEMENTS = new Set([
  "iframe", "frame", "frameset", "object", "embed", "applet", "base", "meta", "link",
]);

export const MAX_HTML = 120_000;
export const MAX_CSS = 60_000;
export const MAX_JS = 120_000;

export function sanitizeCss(css: string): string {
  return css
    .replace(/@import[\s\S]*?;/gi, "")
    .replace(/<\/style/gi, "")
    .slice(0, MAX_CSS);
}

export function sanitizeScript(js: string): string {
  // Keeps a `</script>` inside generated code from terminating the inline tag.
  return js.replace(/<\/script/gi, "<\\/script").slice(0, MAX_JS);
}

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const element of Array.from(doc.body.querySelectorAll("*"))) {
    const tag = element.tagName.toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(tag)) {
      element.remove();
      continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name === "srcdoc") {
        element.removeAttribute(attr.name);
      } else if ((name === "src" || name === "href" || name === "xlink:href") && value && !value.startsWith("#") && !value.startsWith("data:") && !value.startsWith("blob:")) {
        element.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML.slice(0, MAX_HTML);
}

/* The CSP is the hard wall behind the sandbox: inline script and style may
 * run, but every network request — fetch, XHR, imports, css url(), beacons —
 * is refused, so nothing a generated surface does can leave the machine. */
export const SURFACE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:;";
