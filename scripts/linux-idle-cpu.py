#!/usr/bin/env python3
"""Measure idle WebKitGTK CPU of the Ares desktop UI on a virtual display.

Usage:
  xvfb-run -a -s "-screen 0 1400x900x24" python3 scripts/linux-idle-cpu.py \\
      [--url http://127.0.0.1:1420] [--seconds 8] [--mode lite|full] [--shot path]
"""
from __future__ import annotations

import argparse
import glob
import os
import sys
import time

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk, WebKit2  # noqa: E402


def proc_stat(pid: int) -> tuple[int, int] | None:
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as fh:
            parts = fh.read().split()
        return int(parts[13]), int(parts[14])  # utime, stime (clock ticks)
    except (FileNotFoundError, ProcessLookupError, IndexError, ValueError):
        return None


def descendant_pids(root: int) -> set[int]:
    kids: dict[int, list[int]] = {}
    for path in glob.glob("/proc/[0-9]*/stat"):
        try:
            with open(path, encoding="utf-8") as fh:
                parts = fh.read().split()
            pid = int(parts[0])
            ppid = int(parts[3])
        except (OSError, IndexError, ValueError):
            continue
        kids.setdefault(ppid, []).append(pid)
    out: set[int] = set()
    stack = [root]
    while stack:
        cur = stack.pop()
        for child in kids.get(cur, []):
            if child not in out:
                out.add(child)
                stack.append(child)
    return out

def webkit_pids(root: int) -> set[int]:
    """Descendants plus any WebKit helper whose comm matches, in case the
    sandbox reparents WebKitWebProcess away from this tree."""
    pids = descendant_pids(root) | {root}
    for path in glob.glob("/proc/[0-9]*/comm"):
        try:
            with open(path, encoding="utf-8") as fh:
                comm = fh.read().strip()
            if "WebKit" in comm or comm in {"WebKitWebProces", "WebKitNetworkPr"}:
                pids.add(int(path.split("/")[2]))
        except (OSError, ValueError):
            continue
    return pids


def sum_cpu(pids: set[int]) -> int:
    total = 0
    for pid in pids:
        st = proc_stat(pid)
        if st:
            total += st[0] + st[1]
    return total


def clk_tck() -> int:
    return os.sysconf(os.sysconf_names["SC_CLK_TCK"])


class Harness(Gtk.Window):
    def __init__(self, url: str, seconds: float, mode: str, shot: str | None) -> None:
        super().__init__(title="Ares Linux idle CPU")
        self.set_default_size(1400, 900)
        self.url = url
        self.seconds = seconds
        self.mode = mode
        self.shot = shot
        self.view = WebKit2.WebView()
        self.add(self.view)
        self.connect("destroy", Gtk.main_quit)
        self.view.connect("load-changed", self.on_load)
        self.view.load_uri(url)
        self.show_all()

    def on_load(self, _view: WebKit2.WebView, event: WebKit2.LoadEvent) -> None:
        if event != WebKit2.LoadEvent.FINISHED:
            return
        # Boot splash is ~2.15s plus a forge-bloom; wait until .ares is up.
        GLib.timeout_add(3200, self.after_boot)

    def after_boot(self) -> bool:
        flag = "true" if self.mode == "lite" else "false"
        js = (
            "(() => {"
            "  const html = document.documentElement;"
            f"  if ({flag}) {{ html.dataset.perf = 'lite'; }}"
            "  else { delete html.dataset.perf; html.removeAttribute('data-perf'); }"
            "  const ares = document.querySelector('.ares');"
            "  const boot = document.querySelector('.boot');"
            "  return JSON.stringify({"
            "    perf: html.dataset.perf || '',"
            "    style: ares ? ares.getAttribute('data-style') : null,"
            "    flame: ares ? ares.getAttribute('data-flame') : null,"
            "    working: ares ? ares.getAttribute('data-working') : null,"
            "    hasAres: Boolean(ares),"
            "    hasBoot: Boolean(boot),"
            "    ua: navigator.userAgent"
            "  });"
            "})()"
        )
        self.view.run_javascript(js, None, self.on_js, None)
        return False

    def on_js(self, view: WebKit2.WebView, result, _data) -> None:
        info = ""
        try:
            js_result = view.run_javascript_finish(result)
            val = js_result.get_js_value()
            info = val.to_string() if val else ""
        except Exception as exc:  # noqa: BLE001
            info = f"js-error:{exc}"
        print(f"PAGE {info}", flush=True)
        # One extra beat so the idle chrome paints after the splash unmounts.
        GLib.timeout_add(800, self.begin_sample)

    def begin_sample(self) -> bool:
        if self.shot:
            self.save_shot(self.shot)
        self._root = os.getpid()
        self._pids = webkit_pids(self._root)
        self._c0 = sum_cpu(self._pids)
        self._t0 = time.perf_counter()
        print(f"SAMPLE_START pids={sorted(self._pids)}", flush=True)
        GLib.timeout_add(int(self.seconds * 1000), self.end_sample)
        return False

    def save_shot(self, path: str) -> None:
        win = self.get_window()
        if win is None:
            print("SHOT failed: no gdk window", flush=True)
            return
        w, h = self.get_size()
        pb = Gdk.pixbuf_get_from_window(win, 0, 0, w, h)
        if pb is None:
            print("SHOT failed: pixbuf", flush=True)
            return
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        pb.savev(path, "png", [], [])
        print(f"SHOT {path}", flush=True)

    def end_sample(self) -> bool:
        pids = webkit_pids(self._root)
        c1 = sum_cpu(pids)
        dt = time.perf_counter() - self._t0
        ticks = clk_tck()
        cpu_pct = ((c1 - self._c0) / ticks) / dt * 100.0 if dt > 0 else 0.0
        print(
            f"RESULT mode={self.mode} seconds={dt:.2f} ticks={c1 - self._c0} "
            f"cpu_pct={cpu_pct:.1f} pids={len(pids)}",
            flush=True,
        )
        Gtk.main_quit()
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:1420")
    ap.add_argument("--seconds", type=float, default=8.0)
    ap.add_argument("--mode", choices=("lite", "full"), default="lite")
    ap.add_argument("--shot")
    args = ap.parse_args()
    print(
        f"START url={args.url} mode={args.mode} seconds={args.seconds} display={os.environ.get('DISPLAY')}",
        flush=True,
    )
    Harness(args.url, args.seconds, args.mode, args.shot)
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
