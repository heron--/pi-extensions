#!/usr/bin/env python3
"""Real Pi/PTY verification of pi-context-footer, no model calls. Requires pyte.

Run: python3 pi-context-footer/tui.test.py [--output-dir DIR] [--only NAME]

Each case launches the pi on PATH in a pseudo-terminal with scratch settings, a
seeded synthetic session, this checkout's footer, and a synthetic status
producer (an `/fx` command that publishes, clears or delays Pi statuses). It
drives pi with real keystrokes and asserts on the decoded screen, in both
fullscreen and regular TUI mode. Final screens are saved to the output
directory as text and raw ANSI.
"""
import argparse
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import tempfile
import termios
import time
import traceback
import uuid

import pyte

ROOT = Path(__file__).resolve().parent.parent
FOOTER = ROOT / "pi-context-footer/index.ts"
MODEL_PICKER = ROOT / "pi-model-picker/index.ts"
WRITE_LOCK = ROOT / "pi-write-lock/index.ts"

PRODUCER = r'''
// A synthetic status producer. `\e`, `\a` and `\n` in typed text become ESC,
// BEL and a newline, so tests can publish styled, linked and hostile text.
export default function (pi) {
  pi.on("session_start", async (event, ctx) => {
    ctx.ui.setStatus("fx-session", `session ${event.reason}`);
  });
  const decode = (text) => text.replace(/\\e/g, "\x1b").replace(/\\a/g, "\x07").replace(/\\n/g, "\n");
  pi.registerCommand("fx", {
    description: "test status producer",
    handler: async (args, ctx) => {
      const [verb, key, ...rest] = args.trim().split(" ");
      const text = decode(rest.join(" "));
      if (verb === "set") ctx.ui.setStatus(key, text);
      if (verb === "clear") ctx.ui.setStatus(key, undefined);
      if (verb === "later") setTimeout(() => ctx.ui.setStatus(key, text), 1000);
      if (verb === "theme") ctx.ui.setTheme(key);
    },
  });
}
'''

USAGE = {"input": 1200, "output": 300, "cacheRead": 500, "cacheWrite": 0, "totalTokens": 2000,
         "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}

PINNED = {
    "topLeft": ["model", "directory", "context"],
    "topRight": ["session-name"],
    "bottomLeft": [],
    "bottomRight": ["tokens", {"status": "fx-cost", "color": "success", "maxWidth": 16},
                    {"status": "fx-styled", "presentation": "producer"}, {"status": "fx-session"}],
}


def seed(cwd):
    """Two user turns with assistant replies, so /fork and /tree have targets."""
    entries = [{"type": "session", "version": 3, "id": str(uuid.uuid4()),
                "timestamp": "2026-01-01T00:00:00Z", "cwd": str(cwd)}]
    parent = None
    for turn in ("first question", "second question"):
        for message in ({"role": "user", "content": turn, "timestamp": 0},
                        {"role": "assistant", "content": [{"type": "text", "text": f"answer to {turn}"}],
                         "api": "openai-completions", "provider": "openai", "model": "gpt-4o",
                         "timestamp": 0, "stopReason": "stop", "usage": USAGE}):
            entry_id = uuid.uuid4().hex[:8]
            entries.append({"type": "message", "id": entry_id, "parentId": parent,
                            "timestamp": "2026-01-01T00:00:00Z", "message": message})
            parent = entry_id
    return "\n".join(json.dumps(entry) for entry in entries) + "\n"


class Pi:
    """One pi process in a pty, with a pyte screen fed from its output."""

    def __init__(self, scratch, width, height=36, layout=None, extra=(), tui_mode="fullscreen", config=None):
        self.width, self.height = width, height
        cwd = scratch / "demo-repo"
        cwd.mkdir()
        agent = scratch / "agent"
        (agent / "pi-context-footer").mkdir(parents=True)
        (agent / "settings.json").write_text(json.dumps(
            {"theme": "dark", "quietStartup": True, "tuiMode": tui_mode}))
        self.config_file = agent / "pi-context-footer" / "config.json"
        self.write_config({"animate": False, **({"layout": layout} if layout else {}), **(config or {})})
        producer = scratch / "producer.ts"
        producer.write_text(PRODUCER)
        session = scratch / "session.jsonl"
        session.write_text(seed(cwd))
        args = ["pi", "--no-extensions", "-e", str(FOOTER), "-e", str(producer)]
        for path in extra:
            args += ["-e", str(path)]
        args += ["--offline", "--no-skills", "--no-prompt-templates", "--no-themes",
                 "--provider", "openai", "--model", "gpt-4o", "--session", str(session)]
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.environ.update({"PI_CODING_AGENT_DIR": str(agent), "TERM": "xterm-256color",
                               "COLORTERM": "truecolor"})
            os.execvp("pi", args)
        self.screen = pyte.Screen(width, height)
        self.stream = pyte.Stream(self.screen)
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.raw = bytearray()
        self.set_size(width, height)
        self.exited = False

    def write_config(self, config):
        self.config_file.write_text(json.dumps(config))

    def set_size(self, width, height=None):
        self.width, self.height = width, height or self.height
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", self.height, self.width, 0, 0))
        self.screen.resize(self.height, self.width)
        if hasattr(self, "raw"):
            os.kill(self.pid, signal.SIGWINCH)

    def pump(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError:
                    self.exited = True
                    return
                if not chunk:
                    self.exited = True
                    return
                self.raw.extend(chunk)
                self.stream.feed(self.decoder.decode(chunk))

    def text(self):
        return "\n".join(line.rstrip() for line in self.screen.display)

    def wait(self, predicate, what, timeout=10):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.pump(0.1)
            if predicate(self.text()):
                return self.text()
        raise AssertionError(f"timed out waiting for {what}:\n{self.text()}")

    def send(self, keys, settle=0.4):
        self.os_write(keys)
        self.pump(settle)

    def os_write(self, keys):
        os.write(self.fd, keys.encode() if isinstance(keys, str) else keys)

    def command(self, line, settle=0.6):
        self.send(line, 0.2)
        self.send("\r", settle)

    # Frame inspection -------------------------------------------------------
    def rows(self):
        return [line.rstrip() for line in self.screen.display]

    def frame(self):
        """(top rule, bottom rule) of the prompt frame, asserting there is exactly one."""
        rows = self.rows()
        tops = [i for i, row in enumerate(rows) if row.startswith("╭") and row.endswith("╮")]
        bottoms = [i for i, row in enumerate(rows) if row.startswith("╰") and row.endswith("╯")]
        assert len(tops) == 1 and len(bottoms) == 1, f"expected one frame:\n{self.text()}"
        assert tops[0] < bottoms[0]
        for row in rows[tops[0] + 1:bottoms[0]]:
            assert row.startswith(("│", "├")), f"unrailed row {row!r}:\n{self.text()}"
        return rows[tops[0]], rows[bottoms[0]]

    def fg_at(self, needle):
        for y, row in enumerate(self.screen.display):
            x = row.find(needle)
            if x >= 0:
                return self.screen.buffer[y][x].fg
        raise AssertionError(f"{needle!r} not on screen:\n{self.text()}")

    def check_no_errors(self):
        assert b"exceeds terminal width" not in self.raw, "a row overflowed the terminal"
        assert b"Failed to load extension" not in self.raw
        assert b"context-footer config" not in self.raw, "unexpected config warning"

    def close(self, output_dir, name):
        (output_dir / f"{name}.txt").write_text(self.text() + "\n")
        (output_dir / f"{name}.ansi").write_bytes(bytes(self.raw))
        if not self.exited:
            os.kill(self.pid, signal.SIGKILL)
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        os.close(self.fd)


CASES = {}


def case(function):
    CASES[function.__name__] = function
    return function


def started(pi):
    """Wait for the footer; a pi that never gets there is closed, not leaked."""
    try:
        pi.wait(lambda text: "GPT-4o" in text, "the footer to draw")
    except BaseException:
        pi.close(OUTPUT, f"startup-{pi.pid}-FAILED")
        raise
    return pi


@case
def widths_and_resizes(scratch, mode):
    """Framed at 24+ columns, plain below; resizing both ways keeps one frame or none."""
    pi = started(Pi(scratch, 120, tui_mode=mode))
    try:
        pi.command("/name naming things")
        for width in [120, 80, 40, 26, 24, 23, 24, 40, 80, 120]:
            pi.set_size(width)
            pi.pump(0.6)
            if width >= 24:
                top, bottom = pi.frame()
                assert len(top) == width and len(bottom) == width, (width, top, bottom)
                assert "naming" in top, f"anchored session name clipped away at {width}:\n{pi.text()}"
            else:
                assert not any(row.startswith("╭") for row in pi.rows()), pi.text()
                assert "GPT-4o" in pi.text(), f"plain mode lost the model at {width}:\n{pi.text()}"
        top, bottom = pi.frame()
        assert re.search(r"GPT-4o ── . demo-repo ── . ░+ \d+%/128k", top), top
        assert re.search(r"⇡3\.4k ⇣600 ──╯$", bottom), bottom
        pi.check_no_errors()
        return pi
    except BaseException:
        pi.close(OUTPUT, f"widths_and_resizes-{mode}-FAILED")
        raise


@case
def status_items(scratch, mode):
    """Selection, availability and visibility of status items under a pinned layout."""
    pi = started(Pi(scratch, 100, layout=PINNED, tui_mode=mode))
    try:
        _, bottom = pi.frame()
        assert bottom.startswith("╰──────"), f"empty bottom-left keeps its border: {bottom}"
        assert "session startup" in bottom, bottom

        pi.command("/fx set fx-cost $0.00")
        assert re.search(r"⇣600 ── \$0\.00 ── session startup ──╯$", pi.frame()[1]), pi.text()

        pi.command("/fx set fx-cost a long reported cost text")
        _, bottom = pi.frame()
        assert "a long reported…" in bottom, bottom

        pi.command("/fx set fx-styled \\e[31mred\\e[0m \\e]8;;https://example.com\\aLINK\\e]8;;\\a")
        _, bottom = pi.frame()
        assert "red LINK" in bottom, bottom
        assert pi.fg_at("red LINK") == "red", "producer mode keeps the producer's color"
        assert b"\x1b]8;;https://example.com\x07" in pi.raw, "the link reaches the terminal"

        # pyte counts an emoji with a skin-tone modifier as four columns where
        # pi-tui and current terminals count two, so the screen test uses a
        # plain emoji; status.test.mjs covers modifier sequences.
        pi.command("/fx set fx-cost 日本語 👍 e\u0301")
        assert "日本語" in pi.frame()[1], pi.text()

        pi.command("/fx set fx-cost \\e[2J\\e[Hboom\\nline")
        _, bottom = pi.frame()
        assert "boom line" in bottom, bottom
        assert "first question" in pi.text() or "answer to" in pi.text(), "the screen was not cleared"

        # Clipped at 40 columns, still selected: back at 100 it returns.
        pi.command("/fx set fx-cost $1.00")
        pi.set_size(40)
        pi.pump(0.6)
        assert "session startup" not in pi.frame()[1], pi.text()
        pi.set_size(100)
        pi.pump(0.6)
        assert "session startup" in pi.frame()[1], pi.text()

        # A pinned layout ignores an unrelated status; clearing removes the item.
        pi.command("/fx set zz-unrelated NEW")
        assert "NEW" not in pi.text(), pi.text()
        pi.command("/fx clear fx-cost")
        _, bottom = pi.frame()
        assert "$1.00" not in bottom and " ──  ── " not in bottom, bottom

        # Configuration reload opens the layout to remaining statuses.
        pi.write_config({"animate": False, "layout": {**PINNED, "bottomLeft": [{"remainingStatuses": True}]}})
        pi.command("/context-footer reload")
        assert re.search(r"^╰── NEW ─", pi.frame()[1]), pi.text()

        # An idle update repaints with animation off and no keystroke.
        pi.command("/fx later fx-cost $9.99")
        pi.wait(lambda text: "$9.99" in text, "an idle status update to repaint")
        pi.frame()

        pi.command("/context-footer statuses")
        pi.wait(lambda text: '"zz-unrelated" — remaining statuses in bottomLeft' in text, "the discovery report")
        pi.check_no_errors()
        return pi
    except BaseException:
        pi.close(OUTPUT, f"status_items-{mode}-FAILED")
        raise


@case
def plain_mode_statuses(scratch, mode):
    """Plain mode keeps the layout's selection and order, and repaints on updates."""
    pi = started(Pi(scratch, 23, layout=PINNED, tui_mode=mode))
    try:
        pi.command("/fx set fx-cost $5")
        pi.wait(lambda text: re.search(r"⇡3\.4k ⇣600  ──  \$5", text), "the plain row")
        pi.command("/fx later fx-cost $6")
        pi.wait(lambda text: "$6" in text, "an idle plain-mode repaint")
        pi.check_no_errors()
        return pi
    except BaseException:
        pi.close(OUTPUT, f"plain_mode_statuses-{mode}-FAILED")
        raise


@case
def editor_states(scratch, mode):
    """Multiline input, completions, bash mode, theme changes and the footer toggle."""
    pi = started(Pi(scratch, 90, tui_mode=mode))
    try:
        border = pi.fg_at("╭")
        pi.send("\x1b[200~line one\nline two\nline three\x1b[201~")
        pi.wait(lambda text: "line three" in text, "multiline input")
        top_index = pi.rows().index(pi.frame()[0])
        assert any("│ line two" in row for row in pi.rows()[top_index:]), pi.text()
        pi.send("\x03", 0.5)

        pi.send("/")
        pi.wait(lambda text: any(row.startswith("├") for row in text.split("\n")), "completions inside the frame")
        pi.frame()
        pi.send("\x03", 0.5)

        pi.send("!ls")
        pi.pump(0.5)
        assert pi.fg_at("╭") != border, "bash mode tints the frame"
        pi.send("\x03", 0.5)
        assert pi.fg_at("╭") == border

        pi.command("/fx theme light", 1.0)
        pi.frame()
        pi.command("/fx theme dark", 1.0)

        pi.command("/context-footer off")
        assert not any(row.startswith("╭") for row in pi.rows()), pi.text()
        pi.command("/context-footer on")
        pi.frame()
        pi.check_no_errors()
        return pi
    except BaseException:
        pi.close(OUTPUT, f"editor_states-{mode}-FAILED")
        raise


@case
def lifecycle(scratch, mode):
    """Pi reload and session replacement keep exactly one frame with current data."""
    layout = {**PINNED, "bottomRight": ["tokens", {"status": "fx-session"}]}
    pi = started(Pi(scratch, 100, layout=layout, extra=[WRITE_LOCK], tui_mode=mode))
    try:
        pi.command("/reload", 2.0)
        pi.wait(lambda text: "session reload" in text, "the reloaded producer's status")
        pi.frame()

        pi.command("/fork", 1.0)
        pi.send("\r", 2.0)
        pi.wait(lambda text: "session fork" in text, "the forked session's status")
        pi.frame()

        pi.command("/tree", 1.0)
        pi.send("\x1b[A\r", 1.5)
        pi.send("\x1b", 0.5)
        pi.frame()

        pi.command("/new", 2.0)
        pi.wait(lambda text: "session new" in text, "the new session's status")
        _, bottom = pi.frame()
        assert "⇡" not in bottom, f"a new session has no token totals: {bottom}"

        pi.command("/quit", 0.5)
        end = time.monotonic() + 5
        while not pi.exited and time.monotonic() < end:
            pi.pump(0.2)
        assert pi.exited, "pi did not exit: a timer may be holding it open"
        pi.check_no_errors()
        return pi
    except BaseException:
        pi.close(OUTPUT, f"lifecycle-{mode}-FAILED")
        raise


@case
def model_picker(scratch, mode):
    """With the model picker loaded, /model opens its own picker inside one frame."""
    pi = started(Pi(scratch, 100, extra=[MODEL_PICKER], tui_mode=mode))
    try:
        pi.frame()
        pi.command("/model", 1.0)
        pi.wait(lambda text: "type to filter by name, id, or provider" in text, "the custom model picker")
        pi.send("\x1b", 0.8)
        pi.send("\x1b", 0.8)
        pi.frame()
        pi.check_no_errors()
        return pi
    except BaseException:
        pi.close(OUTPUT, f"model_picker-{mode}-FAILED")
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--only", choices=list(CASES))
    options = parser.parse_args()
    OUTPUT = options.output_dir or Path(tempfile.mkdtemp(prefix="pi-context-footer-tui-"))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    print(f"Screens: {OUTPUT}", flush=True)
    failures = 0
    for name, function in CASES.items():
        if options.only and options.only != name:
            continue
        for mode in ("fullscreen", "regular"):
            with tempfile.TemporaryDirectory(prefix="pi-context-footer-tui-") as scratch:
                try:
                    pi = function(Path(scratch), mode)
                    pi.close(OUTPUT, f"{name}-{mode}")
                    print(f"PASS {name} ({mode})", flush=True)
                except AssertionError as error:
                    failures += 1
                    print(f"FAIL {name} ({mode}): {error}", flush=True)
                    traceback.print_exc()
    raise SystemExit(1 if failures else 0)
