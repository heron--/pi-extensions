#!/usr/bin/env python3
"""Real-terminal verification of install.sh. Requires pyte.

Run: python3 scripts/install/tui.test.py

Each case copies this checkout, without node_modules, to a scratch directory
and runs the copy's install.sh in a pseudo-terminal against a scratch
PI_CODING_AGENT_DIR. It drives the installer with real keystrokes and asserts
on the decoded screen and on the links and config files left behind. npm is
never run: the dependency offer is declined.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
import traceback

import pyte

ROOT = Path(__file__).resolve().parents[2]
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78]")
UP, DOWN, ENTER, ESC, CTRL_C = "\x1b[A", "\x1b[B", "\r", "\x1b", "\x03"


class Session:
    """install.sh in a pty: the decoded screen, plus a plain-text transcript of everything written."""

    def __init__(self, checkout, agent_dir, columns=100, rows=30):
        self.screen = pyte.Screen(columns, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = b""
        self.mark = 0
        self.status = None
        pid, fd = pty.fork()
        if pid == 0:
            env = {key: value for key, value in os.environ.items() if key != "NO_COLOR"}
            env.update(PI_CODING_AGENT_DIR=str(agent_dir), TERM="xterm-256color")
            os.chdir(checkout)
            os.execve("/bin/sh", ["sh", "./install.sh"], env)
        self.pid, self.fd = pid, fd
        self.resize(columns, rows)

    def resize(self, columns, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        self.screen.resize(rows, columns)

    def pump(self, seconds=0.05):
        deadline = time.time() + seconds
        while True:
            ready, _, _ = select.select([self.fd], [], [], max(0, deadline - time.time()))
            if not ready:
                return
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            self.raw += chunk
            self.stream.feed(chunk)

    def text(self):
        return ANSI.sub("", self.raw.decode("utf-8", "replace"))

    def expect(self, needle, timeout=10):
        """Wait until `needle` appears after the previous match, and move past it."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.pump()
            found = self.text().find(needle, self.mark)
            if found >= 0:
                self.mark = found + len(needle)
                return
        raise AssertionError(f"timed out waiting for {needle!r}\n--- screen ---\n" + "\n".join(self.lines()) + "\n--- transcript tail ---\n" + self.text()[-1500:])

    def send(self, keys, settle=0.15):
        os.write(self.fd, keys.encode())
        self.pump(settle)

    def answer(self, prompt, reply):
        self.expect(prompt)
        self.send(reply + ENTER)

    def lines(self):
        return [line.rstrip() for line in self.screen.display]

    def wait(self, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.pump()
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.pump()
                os.close(self.fd)
                self.status = os.waitstatus_to_exitcode(status)
                return self.status
        raise AssertionError("install.sh did not exit\n" + self.text()[-1500:])


ROW = re.compile(r"^[> ] \[[ x]\] (\S+)")


def menu_rows(session):
    return [line for line in session.lines() if ROW.match(line)]


def extension_names(checkout):
    """The extensions in menu order, as the installer lists them."""
    script = "import('./scripts/install/catalog.mjs').then(({ discoverExtensions }) => console.log(JSON.stringify(discoverExtensions('.').extensions.map(({ name }) => name))))"
    return json.loads(subprocess.run(["node", "-e", script], cwd=checkout, check=True, capture_output=True, text=True).stdout)


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def case_menu_fits_every_width(checkout, agent_dir):
    names = extension_names(checkout)
    for columns in (100, 60, 40):
        session = Session(checkout, agent_dir, columns=columns, rows=30)
        session.expect("↑↓ move")
        rows = menu_rows(session)
        check([ROW.match(row).group(1) for row in rows] == names,
              f"{columns} columns: one row per extension, unwrapped\n" + "\n".join(session.lines()))
        check(all(len(line) < columns for line in session.lines()), f"{columns} columns: a row reaches the edge")
        check(rows[0].startswith("> [ ] "), "the cursor starts on the first, unchecked row")
        session.resize(36, 30)
        session.send(DOWN)
        rows = menu_rows(session)
        check(len(rows) == len(names) and rows[1].startswith("> "), "a resize redraws the rows at the new width\n" + "\n".join(session.lines()))
        session.send(ESC, settle=1.0)
        session.expect("Cancelled — nothing changed.")
        check(session.wait() == 1, "Esc exits 1")
    check(not (agent_dir / "extensions").exists(), "cancelling links nothing")


def case_short_terminal_scrolls(checkout, agent_dir):
    names = extension_names(checkout)
    session = Session(checkout, agent_dir, columns=80, rows=9)
    session.expect("↑↓ move")
    check(len(menu_rows(session)) == 9 - 5, "the list shrinks to the rows available\n" + "\n".join(session.lines()))
    check(f"1/{len(names)} ·" in session.lines()[-1], "the hint shows the position")
    session.send(UP)
    check(names[-1] in menu_rows(session)[-1] and menu_rows(session)[-1].startswith("> "), "up from the top wraps to the last row")
    check(f"{len(names)}/{len(names)} ·" in session.lines()[-1], "the position follows the cursor")
    session.send(CTRL_C)
    check(session.wait() == 130, "Ctrl+C exits 130")


def case_install_change_and_remove(checkout, agent_dir):
    extensions = agent_dir / "extensions"
    names = extension_names(checkout)
    footer, recap = "pi-context-footer", "pi-recap"
    down_to = lambda name: DOWN * names.index(name)

    def customize_footer():
        session.answer(f"Customize {footer} settings? [y/N]", "y")
        session.answer("Animate the gloss on the max thinking level (yes, no) [yes]: ", "no")
        session.answer("Show the hostname in the frame (yes, no) [no]: ", "")
        session.expect("Saved animate to")

    def customize_recap():
        session.answer(f"Customize {recap} settings? [y/N]", "y")
        session.answer("Recap style (frame, clean) [frame]: ", "box")
        session.expect("Choose one of: frame, clean.")
        session.answer("Recap style (frame, clean) [frame]: ", "clean")
        session.answer("Minutes between recap checks (0.05–240) [5]: ", "")
        session.answer("Interactions needed for a recap (1–1000) [5]: ", "10")
        session.expect("Saved style, minimumCompletedInteractions to")

    # First run: pick two extensions, decline npm, customize both. Output follows menu order.
    chosen = [name for name in names if name in (footer, recap)]
    session = Session(checkout, agent_dir)
    session.expect("↑↓ move")
    session.send(down_to(chosen[0]) + " " + DOWN * (names.index(chosen[1]) - names.index(chosen[0])) + " ")
    rows = menu_rows(session)
    check(rows[names.index(chosen[0])].startswith("  [x] " + chosen[0]) and rows[names.index(chosen[1])].startswith("> [x] " + chosen[1]), "space checks rows\n" + "\n".join(rows))
    session.send(ENTER)
    session.expect(f"Selected: {chosen[0]}, {chosen[1]}")
    for name in chosen:
        session.expect(f"linked   {name}")
    session.expect("linked   lib")
    session.answer("--omit=dev`? [Y/n]", "n")
    for name in chosen:
        (customize_footer if name == footer else customize_recap)()
    session.expect("Done.")
    check(session.wait() == 0, "a completed run exits 0")
    for name in (footer, recap, "lib"):
        check(os.readlink(extensions / name) == str(checkout / name), f"{name} links into the checkout")
    check(json.loads((agent_dir / footer / "config.json").read_text()) == {"animate": False}, "only the changed footer setting is written")
    check(json.loads((agent_dir / recap / "config.json").read_text()) == {"style": "clean", "minimumCompletedInteractions": 10}, "only the changed recap settings are written")

    # Second run: the menu starts from the links; deselecting one offers its removal.
    session = Session(checkout, agent_dir)
    session.expect("↑↓ move")
    rows = menu_rows(session)
    check([row[2:5] for row in rows] == ["[x]" if name in (footer, recap) else "[ ]" for name in names], "linked extensions start checked\n" + "\n".join(rows))
    session.send(down_to(recap) + " " + ENTER)
    session.expect("These links are no longer needed:")
    session.expect(f"{recap}  not selected")
    session.answer("Remove them? [y/N]", "y")
    session.expect(f"removed  {recap}")
    session.answer("--omit=dev`? [Y/n]", "n")
    session.answer(f"Customize {footer} settings? [y/N]", "")
    session.expect("Done.")
    check(session.wait() == 0, "the second run exits 0")
    check(not os.path.lexists(extensions / recap), "the deselected link is removed")
    check((agent_dir / recap / "config.json").exists(), "removing a link keeps its settings")

    # Third run, same selection: nothing to do.
    session = Session(checkout, agent_dir)
    session.expect("↑↓ move")
    session.send(ENTER)
    session.expect("Links are already up to date.")
    session.answer("--omit=dev`? [Y/n]", "n")
    session.answer(f"Customize {footer} settings? [y/N]", "")
    session.expect("Nothing changed.")
    check(session.wait() == 0, "an unchanged run exits 0")

    # Fourth run: clear the selection; lib goes with the last extension.
    session = Session(checkout, agent_dir)
    session.expect("↑↓ move")
    session.send("a")
    check(all(row[2:5] == "[x]" for row in menu_rows(session)), "a checks every row when some are unchecked")
    session.send("a")
    check(all(row[2:5] == "[ ]" for row in menu_rows(session)), "a clears every row when all are checked")
    session.send(ENTER)
    session.expect("Selected: none")
    session.expect(f"{footer}  not selected")
    session.expect("lib  no selected extension needs it")
    session.answer("Remove them? [y/N]", "y")
    session.expect(f"removed  {footer}")
    session.expect("removed  lib")
    session.expect("Done.")
    check(session.wait() == 0, "the fourth run exits 0")
    check(sorted(os.listdir(extensions)) == [], "every link is gone")


def case_never_touches_what_it_does_not_own(checkout, agent_dir):
    extensions = agent_dir / "extensions"
    names = extension_names(checkout)
    other = checkout.parent / "other-checkout"
    shutil.copytree(checkout / names[1], other / names[1])
    (extensions / names[0]).mkdir(parents=True)
    os.symlink(other / names[1], extensions / names[1])
    os.symlink(checkout / "pi-renamed", extensions / "pi-renamed")
    session = Session(checkout, agent_dir)
    session.expect("↑↓ move")
    rows = menu_rows(session)
    check("blocked by a directory" in rows[0] and "linked from elsewhere" in rows[1], "the menu notes links it does not own\n" + "\n".join(rows))
    session.send(" " + DOWN + " " + ENTER)
    session.expect("These links point somewhere other than this checkout:")
    session.answer("Replace them? [y/N]", "")
    session.expect("pi-renamed  points to a path this checkout no longer has")
    session.answer("Remove them? [y/N]", "y")
    session.expect("removed  pi-renamed")
    session.expect(f"skipped  {names[0]}: a real directory is in the way")
    session.expect("Done.")
    check(session.wait() == 0, "the run exits 0")
    check("Customize" not in session.text() and "npm" not in session.text(), "nothing is offered for extensions left unlinked")
    check((extensions / names[0]).is_dir() and not (extensions / names[0]).is_symlink(), "the real directory is untouched")
    check(os.readlink(extensions / names[1]) == str(other / names[1]), "a declined replacement keeps the other checkout's link")
    check(not os.path.lexists(extensions / "pi-renamed"), "the broken link into the checkout is removed")


CASES = [
    case_menu_fits_every_width,
    case_short_terminal_scrolls,
    case_install_change_and_remove,
    case_never_touches_what_it_does_not_own,
]


def main():
    failures = 0
    for case in CASES:
        scratch = Path(tempfile.mkdtemp(prefix="pi-install-tui-"))
        try:
            checkout = scratch / "checkout"
            shutil.copytree(ROOT, checkout, symlinks=True, ignore=shutil.ignore_patterns("node_modules", ".git", ".pi"))
            agent_dir = scratch / "agent"
            agent_dir.mkdir()
            case(checkout, agent_dir)
            print(f"ok   {case.__name__}")
        except Exception:
            failures += 1
            print(f"FAIL {case.__name__}")
            traceback.print_exc()
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
    print(f"{len(CASES) - failures}/{len(CASES)} passed")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
