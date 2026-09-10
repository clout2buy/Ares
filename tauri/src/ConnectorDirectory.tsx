// The connector directory (/mcp): everything Ares can plug into, one click
// each. Connected servers with their live tool counts, the curated catalog
// grouped by what people reach for, the whole public MCP registry with
// search and paging, and "add by URL" that first asks the server what it
// needs. OAuth is the default path — sign in with the service, no keys.
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { McpCatalogVm, McpConnectorVm, McpRegistryResult, McpServerStatusVm, McpToolsVm } from "./state/events";

type Filter = "all" | "connected" | string;

function initialOf(name: string): string {
  const m = name.trim().match(/[A-Za-z0-9]/);
  return (m ? m[0] : "?").toUpperCase();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function connectedByUrl(connectors: McpConnectorVm[], url: string): McpConnectorVm | undefined {
  const norm = url.replace(/\/+$/, "").toLowerCase();
  return connectors.find((c) => c.url.replace(/\/+$/, "").toLowerCase() === norm);
}

export function ConnectorDirectory({
  connectors,
  servers,
  catalog,
  categories,
  connecting,
  tools,
  registry,
  registryCursor,
  probe,
  prefill,
  onConnect,
  onConnectWithToken,
  onDisconnect,
  onToggle,
  onListTools,
  onSearchRegistry,
  onProbe,
  onRefreshTools,
  onClose,
}: {
  connectors: McpConnectorVm[];
  servers: McpServerStatusVm[];
  catalog: McpCatalogVm[];
  categories: Array<{ id: string; label: string }>;
  connecting: string | null;
  tools: Record<string, McpToolsVm>;
  registry: { text: string; results: McpRegistryResult[]; searching: boolean; error?: string | null } | null;
  registryCursor: string | null;
  probe: { url: string; auth?: string; registration?: boolean; transport?: string; note?: string } | null;
  prefill: { url: string; name: string } | null;
  onConnect: (url: string, name: string) => void;
  onConnectWithToken: (url: string, name: string, token: string, header?: string) => void;
  onDisconnect: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
  onListTools: (name: string) => void;
  onSearchRegistry: (text: string, cursor?: string) => void;
  onProbe: (url: string) => void;
  onRefreshTools: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState(prefill?.url ?? "");
  const [customToken, setCustomToken] = useState("");
  const [keyFor, setKeyFor] = useState<McpCatalogVm | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [registryPages, setRegistryPages] = useState<McpRegistryResult[]>([]);
  const searchTimer = useRef<number | null>(null);
  const probeTimer = useRef<number | null>(null);

  useEffect(() => {
    if (prefill?.url) {
      setCustomUrl(prefill.url);
      const entry = catalog.find((c) => c.url === prefill.url);
      if (entry?.auth === "key") setKeyFor(entry);
    }
  }, [prefill, catalog]);

  // registry: debounce the search; accumulate pages
  useEffect(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      setRegistryPages([]);
      onSearchRegistry(query.trim());
    }, query.trim() ? 350 : 0);
    return () => { if (searchTimer.current) window.clearTimeout(searchTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  useEffect(() => {
    if (!registry || registry.searching) return;
    setRegistryPages((prev) => {
      const seen = new Set(prev.map((r) => r.url));
      const fresh = registry.results.filter((r) => !seen.has(r.url));
      return registry.text === query.trim() ? [...prev, ...fresh] : registry.results;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry]);

  // probe a typed URL once it looks like one
  useEffect(() => {
    if (probeTimer.current) window.clearTimeout(probeTimer.current);
    const url = customUrl.trim();
    if (!/^https?:\/\/[^\s]+\.[^\s]+/.test(url)) return;
    probeTimer.current = window.setTimeout(() => onProbe(url), 500);
    return () => { if (probeTimer.current) window.clearTimeout(probeTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customUrl]);

  const q = query.trim().toLowerCase();
  const catalogShown = useMemo(() => catalog.filter((c) => {
    if (filter === "connected") return Boolean(connectedByUrl(connectors, c.url));
    if (filter !== "all" && c.category !== filter) return false;
    if (!q) return true;
    return c.name.toLowerCase().includes(q) || c.blurb.toLowerCase().includes(q) || c.keywords.some((k) => k.includes(q)) || hostOf(c.url).includes(q);
  }), [catalog, filter, q, connectors]);

  const connectedShown = connectors.filter((c) => !q || (c.displayName ?? c.name).toLowerCase().includes(q) || c.url.toLowerCase().includes(q));
  const statusOf = (name: string) => servers.find((s) => s.name === name);
  const catalogUrls = new Set(catalog.map((c) => c.url.replace(/\/+$/, "").toLowerCase()));
  const registryShown = registryPages.filter((r) => !catalogUrls.has(r.url.replace(/\/+$/, "").toLowerCase()));

  const submitCustom = () => {
    const url = customUrl.trim();
    if (!url) return;
    const name = hostOf(url).split(".").slice(0, -1).join("-") || "connector";
    const token = customToken.trim();
    if (token) onConnectWithToken(url, name, token);
    else onConnect(url, name);
  };

  return (
    <div className="paletteScrim" onClick={onClose}>
      <div className="palette directory" onClick={(e) => e.stopPropagation()}>
        <header className="dirHead">
          <div className="dirHeadText">
            <strong>Connectors</strong>
            <span>{connectors.length} connected · {catalog.length} one click away · the whole MCP registry below</span>
          </div>
          <button className="ghost" onClick={onRefreshTools} title="Re-read every connected server's tools">Refresh</button>
          <button className="ghost" onClick={onClose}>Close</button>
        </header>
        <input className="dirSearch" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search GitHub, Vercel, Notion, Stripe… or anything in the MCP registry" spellCheck={false} autoFocus />
        <div className="dirFilters">
          <button data-on={filter === "all" ? "1" : "0"} onClick={() => setFilter("all")}>All</button>
          <button data-on={filter === "connected" ? "1" : "0"} onClick={() => setFilter("connected")}>Connected <em>{connectors.length}</em></button>
          {categories.map((c) => (
            <button key={c.id} data-on={filter === c.id ? "1" : "0"} onClick={() => setFilter(filter === c.id ? "all" : c.id)}>{c.label}</button>
          ))}
        </div>

        <div className="dirScroll">
          {connectedShown.length > 0 && (filter === "all" || filter === "connected") ? (
            <>
              <div className="dirSectionLabel">Connected</div>
              <div className="dirConnected">
                {connectedShown.map((c) => {
                  const open = expanded === c.name;
                  const on = c.enabled !== false;
                  const t = tools[c.name];
                  const st = statusOf(c.name);
                  const entry = catalog.find((e) => e.url.replace(/\/+$/, "").toLowerCase() === c.url.replace(/\/+$/, "").toLowerCase());
                  return (
                    <div key={c.name} className="dirConn" data-open={open ? "1" : "0"} data-on={on ? "1" : "0"} data-err={st?.error ? "1" : "0"}>
                      <div className="dirConnRow">
                        <button className="dirConnMain" onClick={() => { setExpanded(open ? null : c.name); if (!open && !t) onListTools(c.name); }} title={open ? "collapse" : "show tools"}>
                          <span className="dirLogo" aria-hidden="true">{initialOf(entry?.name ?? c.displayName ?? c.name)}</span>
                          <span className="dirConnText">
                            <span className="dirConnName">{entry?.name ?? c.displayName ?? c.name}<i className="dirAuthTag" data-auth={c.oauth ? "oauth" : "key"}>{c.oauth ? "OAuth" : "key"}</i></span>
                            <span className="dirConnMeta">
                              {st?.error ? <b className="dirWarn">{st.error}</b> : st ? `${st.toolCount} tool${st.toolCount === 1 ? "" : "s"}${st.fromCache ? " · cached" : ""}` : hostOf(c.url)}
                              {!on ? " · paused" : ""}
                            </span>
                          </span>
                          <span className="dirConnChevron" data-open={open ? "1" : "0"} aria-hidden="true">▾</span>
                        </button>
                        <button className="dirSwitch" data-on={on ? "1" : "0"} onClick={() => onToggle(c.name, !on)} title={on ? "Pause — keep the sign-in, unload the tools" : "Resume"} aria-label={on ? "pause" : "resume"}>
                          <span className="dirSwitchKnob" />
                        </button>
                        {st?.error && /rejected|connected again|401|403/i.test(st.error) ? (
                          <button className="dirReconnect" onClick={() => onConnect(c.url, c.name)} disabled={connecting !== null}>Reconnect</button>
                        ) : null}
                        <button className="dirDisconnect" onClick={() => onDisconnect(c.name)}>Disconnect</button>
                      </div>
                      {open ? (
                        <div className="dirTools">
                          {!t || t.loading ? (
                            <span className="dirToolsStatus"><span className="skillDockSpin" aria-hidden="true" /> asking {entry?.name ?? c.name} for its tools…</span>
                          ) : t.error ? (
                            <span className="dirToolsStatus warn">{t.error}</span>
                          ) : t.tools.length ? (
                            t.tools.map((tool) => <span key={tool.name} className="dirTool" title={tool.description ?? tool.name}>{tool.name}</span>)
                          ) : (
                            <span className="dirToolsStatus">no tools reported</span>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          {filter !== "connected" ? (
            <>
              <div className="dirSectionLabel">{filter === "all" ? "One click away" : categories.find((c) => c.id === filter)?.label ?? filter}</div>
              {catalogShown.length === 0 ? <div className="dirEmpty">Nothing here matches — the registry below has the long tail.</div> : null}
              <div className="dirGallery">
                {catalogShown.map((p) => {
                  const isConnected = Boolean(connectedByUrl(connectors, p.url));
                  const isConnecting = connecting === p.url;
                  const asking = keyFor?.id === p.id;
                  return (
                    <div key={p.id} className="dirCard" data-connected={isConnected ? "1" : "0"} data-asking={asking ? "1" : "0"}>
                      <button
                        className="dirCardMain"
                        disabled={isConnected || (connecting !== null && !isConnecting)}
                        onClick={() => {
                          if (isConnected) return;
                          if (p.auth === "key") { setKeyFor(asking ? null : p); setKeyValue(""); return; }
                          onConnect(p.url, p.id);
                        }}
                        title={p.docs ?? p.url}
                      >
                        <span className="dirLogo" aria-hidden="true">{initialOf(p.name)}</span>
                        <span className="dirCardBody">
                          <strong>{p.name}<i className="dirAuthTag" data-auth={p.auth}>{p.auth === "oauth" ? "OAuth" : p.auth === "key" ? "API key" : "open"}</i></strong>
                          <em>{p.blurb}</em>
                        </span>
                        <span className="dirCardAction" data-state={isConnected ? "on" : isConnecting ? "busy" : "idle"}>
                          {isConnected ? "connected" : isConnecting ? "waiting for sign-in…" : p.auth === "oauth" ? "Sign in" : p.auth === "key" ? "Add key" : "Connect"}
                        </span>
                      </button>
                      {asking ? (
                        <div className="dirKeyRow">
                          <input className="dirSearch" type="password" value={keyValue} onChange={(e) => setKeyValue(e.target.value)} placeholder={`${p.name} API key`} spellCheck={false} autoFocus />
                          <button className="primary" disabled={!keyValue.trim()} onClick={() => { onConnectWithToken(p.url, p.id, keyValue.trim(), p.keyHeader); setKeyFor(null); setKeyValue(""); }}>Connect</button>
                          {p.keyUrl ? <a className="dirKeyLink" href={p.keyUrl} target="_blank" rel="noreferrer">get a key ↗</a> : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          {filter === "all" ? (
            <>
              <div className="dirSectionLabel">MCP registry {q ? `· “${query.trim()}”` : "· newest"}</div>
              <div className="dirRegistry">
                {registry?.searching && registryShown.length === 0 ? (
                  <div className="dirToolsStatus"><span className="skillDockSpin" aria-hidden="true" /> searching the public registry…</div>
                ) : registry?.error ? (
                  <div className="dirToolsStatus warn">registry unavailable — {registry.error}</div>
                ) : registryShown.length === 0 && !registry?.searching ? (
                  <div className="dirToolsStatus">nothing in the registry for that</div>
                ) : null}
                {registryShown.map((r) => {
                  const isConnected = Boolean(connectedByUrl(connectors, r.url));
                  const isConnecting = connecting === r.url;
                  const asking = keyFor?.id === `reg:${r.url}`;
                  return (
                    <div key={r.url} className="dirCard wide" data-connected={isConnected ? "1" : "0"} data-asking={asking ? "1" : "0"}>
                      <button
                        className="dirCardMain"
                        disabled={isConnected || (connecting !== null && !isConnecting)}
                        onClick={() => {
                          if (isConnected) return;
                          if (r.needsKey) { setKeyFor(asking ? null : { id: `reg:${r.url}`, name: r.name, url: r.url, auth: "key", transport: (r.transport as "http" | "sse") ?? "auto", category: "productivity", blurb: r.description, keywords: [], ...(r.keyHeader ? { keyHeader: r.keyHeader } : {}) }); setKeyValue(""); return; }
                          onConnect(r.url, r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || hostOf(r.url));
                        }}
                        title={r.fullName}
                      >
                        <span className="dirLogo" aria-hidden="true">{initialOf(r.name)}</span>
                        <span className="dirCardBody">
                          <strong>{r.name}<i className="dirAuthTag" data-auth={r.needsKey ? "key" : "oauth"}>{r.needsKey ? "API key" : "sign in / open"}</i><small>{hostOf(r.url)}</small></strong>
                          <em>{r.description || r.fullName}</em>
                        </span>
                        <span className="dirCardAction" data-state={isConnected ? "on" : isConnecting ? "busy" : "idle"}>{isConnected ? "connected" : isConnecting ? "waiting…" : r.needsKey ? "Add key" : "Connect"}</span>
                      </button>
                      {asking ? (
                        <div className="dirKeyRow">
                          <input className="dirSearch" type="password" value={keyValue} onChange={(e) => setKeyValue(e.target.value)} placeholder={`${r.name} ${r.keyHeader ?? "API key"}`} spellCheck={false} autoFocus />
                          <button className="primary" disabled={!keyValue.trim()} onClick={() => { onConnectWithToken(r.url, r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || hostOf(r.url), keyValue.trim(), r.keyHeader); setKeyFor(null); setKeyValue(""); }}>Connect</button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {registryCursor && registryShown.length > 0 ? (
                  <button className="dirMore" disabled={registry?.searching} onClick={() => onSearchRegistry(query.trim(), registryCursor)}>{registry?.searching ? "loading…" : "Load more"}</button>
                ) : null}
              </div>
            </>
          ) : null}

          <div className="dirSectionLabel">Add any MCP server by URL</div>
          <div className="dirCustom">
            <input className="dirSearch" value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
            {probe && probe.url === customUrl.trim() ? (
              <div className="dirProbe" data-auth={probe.auth ?? "unknown"}>
                {probe.auth === "none" ? "Open server — connects without signing in." :
                  probe.auth === "oauth" ? (probe.registration === false ? "Signs in with OAuth, but it does not register apps automatically — paste a token below if you have one." : "Signs in with OAuth — one click.") :
                  probe.auth === "key" ? "Needs a token — paste it below." :
                  probe.auth === "unreachable" ? `Not reachable — ${probe.note ?? "no answer"}` :
                  `Could not tell what it needs${probe.note ? ` (${probe.note})` : ""}.`}
                {probe.transport ? <i> · {probe.transport === "sse" ? "SSE" : "HTTP"}</i> : null}
              </div>
            ) : null}
            <div className="dirCustomRow">
              <input className="dirSearch" type="password" value={customToken} onChange={(e) => setCustomToken(e.target.value)} placeholder="token (only if the server needs one)" spellCheck={false} />
              <button className="primary" disabled={!customUrl.trim() || connecting !== null} onClick={submitCustom}>{customToken.trim() ? "Connect with token" : "Connect"}</button>
            </div>
          </div>
          <p className="dirFootnote">Sign-ins open in your browser and come back here on their own. Tokens are stored encrypted on this machine and never leave it except to the service they belong to.</p>
        </div>
      </div>
    </div>
  );
}
