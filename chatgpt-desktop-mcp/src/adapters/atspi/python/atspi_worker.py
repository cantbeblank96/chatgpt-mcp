#!/usr/bin/env python3
"""AT-SPI sidecar worker for chatgpt-desktop-mcp.

Protocol: JSONL RPC over stdio (one JSON object per line).
  request : {"id": <int>, "method": "<name>", "params": {...}}
  response: {"id": <int>, "ok": true, "result": {...}}
          | {"id": <int>, "ok": false, "error": {"code": "...", "message": "...", "details": {...}}}

Design constraints (ADR-001):
  * must run under the system python3 (/usr/bin/python3) with gi Atspi/Gtk;
  * all Gtk clipboard work happens inside the GLib MainLoop thread;
  * accessible-name locators are bilingual (zh/en);
  * never touches cookies/tokens; only reads the accessibility tree.
"""
import hashlib
import json
import os
import signal
import subprocess
import sys
import time

import gi

gi.require_version('Atspi', '2.0')
gi.require_version('Gtk', '3.0')
from gi.repository import Atspi, Gtk, Gdk, GLib  # noqa: E402

PROTOCOL_VERSION = 1

APP_NAMES = ('Codex', 'ChatGPT', 'chatgpt')
FRAME_NAMES = ('ChatGPT',)
SEND_NAMES = ('发送', 'Send')
STOP_NAMES = ('停止', 'Stop', '停止生成', 'Stop generating')
NEW_CHAT_NAMES = ('新聊天', 'New chat', '新对话', 'New conversation')
USER_HEADINGS = ('你说：', '你说:', 'You said:')
ASSISTANT_HEADINGS = ('ChatGPT 说：', 'ChatGPT 说:', 'ChatGPT said:')
MODE_PREFIXES = ('切换模式，当前模式：', '切换模式,当前模式:', 'Switch mode, current mode:')
GEN_STATUS_MARKERS = ('回应', 'responding')
# Service-side error banners rendered in the chat surface (e.g. rate limits).
# Detecting these lets the MCP layer fail fast with a structured code instead
# of burning the full generation timeout.
ERROR_BANNER_PATTERNS = ('request failed', 'status 429', '429', 'too many requests',
                         'rate limit', '请求失败', '达到上限', '次数已达', '稍后重试',
                         'something went wrong', '出错了', 'network error', '网络错误')
A11Y_FLAG = '--force-renderer-accessibility'
MAX_MESSAGE_CHARS = 200_000


def log(msg):
    sys.stderr.write('[atspi-worker %s] %s\n' % (time.strftime('%H:%M:%S'), msg))
    sys.stderr.flush()


class WorkerError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def norm_text(t):
    """Normalize composer/message text for comparison (drop object-replacement chars & whitespace noise)."""
    if not t:
        return ''
    return ''.join(ch for ch in t if ch != '\ufffc').strip()


# ---------------------------------------------------------------- AT-SPI helpers

def find_app():
    d = Atspi.get_desktop(0)
    for i in range(d.get_child_count()):
        try:
            a = d.get_child_at_index(i)
        except Exception:
            continue
        if a is not None and a.get_name() in APP_NAMES:
            return a
    return None


def find_chat_frames(app):
    frames = []
    for j in range(app.get_child_count()):
        try:
            f = app.get_child_at_index(j)
        except Exception:
            continue
        if f is not None and f.get_name() in FRAME_NAMES:
            frames.append(f)
    return frames


def require_frame():
    app = find_app()
    if app is None:
        raise WorkerError('APP_NOT_RUNNING',
                          'ChatGPT Desktop is not registered on the AT-SPI bus',
                          {'hint': 'check that the chatgpt process is running'})
    frames = find_chat_frames(app)
    if len(frames) == 0:
        raise WorkerError('SURFACE_NOT_FOUND', "no frame named 'ChatGPT' under the app",
                          {'app_name': app.get_name()})
    if len(frames) > 1:
        raise WorkerError('SURFACE_AMBIGUOUS', "multiple frames named 'ChatGPT'",
                          {'count': len(frames)})
    frame = frames[0]
    if frame.get_child_count() <= 0 or frame.get_child_at_index(0) is None:
        raise WorkerError('ADAPTER_BROKEN',
                          'ChatGPT frame subtree is empty: renderer accessibility is not active',
                          {'hint': 'relaunch ChatGPT Desktop with %s (requires user consent)' % A11Y_FLAG})
    return frame


def find_node(root, pred, skip_roles=()):
    try:
        if pred(root):
            return root
    except Exception:
        pass
    try:
        role = root.get_role_name()
        if role in skip_roles:
            return None
    except Exception:
        pass
    for k in range(root.get_child_count()):
        try:
            c = root.get_child_at_index(k)
            if c is not None:
                r = find_node(c, pred, skip_roles)
                if r is not None:
                    return r
        except Exception:
            pass
    return None


def find_entry(frame):
    return find_node(frame, lambda n: n.get_role_name() == 'entry'
                     and n.get_state_set().contains(Atspi.StateType.EDITABLE))


def find_button(frame, names):
    def pred(n):
        try:
            return n.get_role_name() in ('push button', 'toggle button') and (n.get_name() or '') in names
        except Exception:
            return False
    return find_node(frame, pred)


# Sidebar per-row action buttons that are NOT the conversation title.
CONV_ROW_ACTION_NAMES = ('置顶聊天', '归档聊天', 'Pin chat', 'Archive chat')


def conv_titles_from_list(list_node):
    """Read conversation titles from a sidebar 'list' node.

    Each row is a 'list item' whose FIRST push button is the title;
    trailing action buttons (pin/archive) are ignored."""
    titles = []
    for k in range(list_node.get_child_count()):
        try:
            li = list_node.get_child_at_index(k)
        except Exception:
            continue
        if li is None:
            continue
        try:
            if li.get_role_name() != 'list item':
                continue
        except Exception:
            continue
        title = _first_title_button(li, 0)
        if title:
            titles.append(title)
    return titles


def _first_title_button(node, depth):
    if depth > 4:
        return None
    try:
        if node.get_role_name() == 'push button':
            nm = (node.get_name() or '').strip()
            if nm and nm not in CONV_ROW_ACTION_NAMES:
                return nm
    except Exception:
        pass
    for j in range(node.get_child_count()):
        try:
            c = node.get_child_at_index(j)
        except Exception:
            continue
        if c is None:
            continue
        t = _first_title_button(c, depth + 1)
        if t:
            return t
    return None


def collect_text(node):
    """Read composer text from 'static' nodes ONLY.

    The entry exposes the same content through both static and paragraph
    nodes; collecting both double-counts the text. Placeholder text lives
    in a paragraph node and is intentionally excluded.
    """
    out = []

    def rec(x):
        try:
            if x.get_role_name() == 'static':
                ti = x.get_text_iface()
                if ti:
                    out.append(ti.get_text(0, ti.get_character_count()))
        except Exception:
            pass
        for k in range(x.get_child_count()):
            try:
                c = x.get_child_at_index(k)
                if c is not None:
                    rec(c)
            except Exception:
                pass

    rec(node)
    return norm_text(''.join(out))


def leaf_static_text(node):
    """Collect text from LEAF 'static' nodes only.

    A wrapper static around a formatted run already aggregates its
    children's text through its own Text interface; recursing into the
    children would double the text. Leaves carry the true content.
    """
    out = []

    def rec(x):
        try:
            n_children = x.get_child_count()
        except Exception:
            n_children = 0
        try:
            if x.get_role_name() == 'static':
                if n_children == 0:
                    ti = x.get_text_iface()
                    if ti:
                        out.append(ti.get_text(0, ti.get_character_count()))
                    return
        except Exception:
            pass
        for k in range(n_children):
            try:
                c = x.get_child_at_index(k)
                if c is not None:
                    rec(c)
            except Exception:
                pass

    rec(node)
    return ''.join(out)


def paragraph_text(par):
    """Extract message text from a paragraph node.

    The paragraph's own Text interface returns U+FFFC (object replacement
    character) for inline-formatted runs (bold/italic/code are exposed as
    nested static children). Replace each U+FFFC with the collected leaf
    static text of the corresponding child, in order.
    """
    ti = None
    try:
        ti = par.get_text_iface()
    except Exception:
        pass
    raw = ''
    if ti:
        try:
            raw = ti.get_text(0, ti.get_character_count()) or ''
        except Exception:
            raw = ''
    children = []
    for k in range(par.get_child_count()):
        try:
            c = par.get_child_at_index(k)
        except Exception:
            c = None
        if c is not None:
            children.append(c)
    if '\ufffc' not in raw:
        return raw
    out = []
    ci = 0
    for ch in raw:
        if ch == '\ufffc':
            if ci < len(children):
                out.append(leaf_static_text(children[ci]))
                ci += 1
        else:
            out.append(ch)
    return ''.join(out).replace('\ufffc', '')


# Composer placeholder strings (zh/en). When the composer is empty the
# placeholder renders as static text nodes, so emptiness is detected by
# matching against these. (The entry's Text interface is NOT usable:
# get_character_count stays 1 even when text is present.)
PLACEHOLDER_TEXTS = (
    '给 ChatGPT 发消息',
    '给ChatGPT发消息',
    'Message ChatGPT',
    'Send a message to ChatGPT',
)


def entry_is_empty(entry):
    """True when the composer holds no user text (only the placeholder)."""
    t = collect_text(entry)
    return t == '' or t in PLACEHOLDER_TEXTS


def press(node):
    ai = node.get_action_iface()
    if not ai:
        return False
    for k in range(ai.get_n_actions()):
        if ai.get_action_name(k) in ('press', 'click'):
            return bool(ai.do_action(k))
    return False


def xkey(combo):
    subprocess.run(['xdotool', 'key', '--clearmodifiers', combo],
                   capture_output=True, timeout=5)


def activate_chatgpt_window():
    # Match by WM_CLASS, NOT by window title: --name ChatGPT also matches
    # browser tabs titled "ChatGPT" (Chrome etc.) and has previously sent
    # activation/keys to the WRONG window. classname 'ChatGPT' is the
    # Electron app frame; class 'ChatGPT' additionally catches helper
    # windows — prefer classname, fall back to class.
    # --onlyvisible avoids unmapped/other-desktop windows on which
    # `windowactivate --sync` can hang indefinitely.
    r = subprocess.run(['xdotool', 'search', '--onlyvisible', '--classname', 'ChatGPT'],
                       capture_output=True, text=True, timeout=5)
    wids = [w for w in r.stdout.split() if w]
    if not wids:
        r = subprocess.run(['xdotool', 'search', '--onlyvisible', '--class', 'ChatGPT'],
                           capture_output=True, text=True, timeout=5)
        wids = [w for w in r.stdout.split() if w]
    if not wids:
        raise WorkerError('SURFACE_NOT_FOUND', 'no visible X window with WM_CLASS ChatGPT',
                          {'hint': 'window may be minimized, on another desktop, or closed'})
    try:
        subprocess.run(['xdotool', 'windowactivate', '--sync', wids[0]],
                       capture_output=True, timeout=3)
    except subprocess.TimeoutExpired:
        # --sync can hang when the WM is slow; the async variant still
        # requests activation.
        log('windowactivate --sync timed out, retrying without --sync')
        subprocess.run(['xdotool', 'windowactivate', wids[0]],
                       capture_output=True, timeout=3)


def find_chatgpt_process():
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            with open('/proc/%s/cmdline' % pid, 'rb') as f:
                raw = f.read().decode('utf-8', 'replace')
        except Exception:
            continue
        # Chromium may rewrite its cmdline space-separated into a single token,
        # so tokenize on both NUL and whitespace.
        tokens = raw.replace('\0', ' ').split()
        if not tokens:
            continue
        base = os.path.basename(tokens[0]).lower()
        if base in ('chatgpt', 'chatgpt-desktop') and not any(t.startswith('--type=') for t in tokens):
            return {'pid': int(pid), 'argv': tokens}
    return None


# ---------------------------------------------------------------- state scanning

def scan_state(frame):
    """Scan the Chat surface; return messages, generation state, composer text, mode."""
    state = {
        'status_bars': [],
        'stop_button': False,
        'error_banner': None,  # text of a visible service error banner, if any
        'messages': [],       # [{"role": "user"|"assistant", "text": str}]
        'composer_text': '',
        'mode': None,
        'mode_button_found': False,
    }
    current = None  # current message segment role

    def heading_role_of(name):
        if any(name == h or name.startswith(h.rstrip('：:')) for h in USER_HEADINGS):
            return 'user'
        if any(name.startswith(h.rstrip('：:')) for h in ASSISTANT_HEADINGS) or name.lower().startswith('chatgpt said'):
            return 'assistant'
        return None

    def flush():
        nonlocal current
        if current is not None and current['text']:
            state['messages'].append(current)
        current = None

    def rec(n):
        nonlocal current
        try:
            role = n.get_role_name()
            name = n.get_name() or ''
        except Exception:
            return
        if role == 'entry':
            # composer: capture text but never descend into message logic
            if n.get_state_set().contains(Atspi.StateType.EDITABLE):
                t = collect_text(n)
                # placeholder-only composer is logically empty
                state['composer_text'] = '' if t in PLACEHOLDER_TEXTS else t
            return
        if role == 'status bar' and name:
            state['status_bars'].append(name[:120])
        if name and state['error_banner'] is None and role in ('static', 'label', 'paragraph', 'section', 'alert'):
            low = name.lower()
            if any(p in low for p in ERROR_BANNER_PATTERNS):
                state['error_banner'] = name[:160]
        if role == 'push button':
            if name in STOP_NAMES:
                state['stop_button'] = True
            for p in MODE_PREFIXES:
                if name.startswith(p):
                    state['mode_button_found'] = True
                    state['mode'] = name[len(p):].strip()
        if role == 'heading' and name:
            hr = heading_role_of(name)
            if hr is not None:
                flush()
                current = {'role': hr, 'text': ''}
            else:
                flush()  # non-marker heading closes the segment
        if role == 'paragraph' and current is not None:
            # NOTE: 'paragraph' only. Message content is duplicated across
            # static/paragraph nodes; collecting both would double the text.
            t = paragraph_text(n)
            if t and t.strip():
                if len(current['text']) < MAX_MESSAGE_CHARS:
                    sep = '\n' if current['text'] else ''
                    current['text'] += sep + t.strip()
        for k in range(n.get_child_count()):
            try:
                c = n.get_child_at_index(k)
                if c is not None:
                    rec(c)
            except Exception:
                pass

    rec(frame)
    flush()
    state['generating'] = state['stop_button'] or any(
        any(m in s.lower() if m.isascii() else m in s for m in GEN_STATUS_MARKERS)
        for s in state['status_bars'])
    state['user_count'] = sum(1 for m in state['messages'] if m['role'] == 'user')
    state['assistant_count'] = sum(1 for m in state['messages'] if m['role'] == 'assistant')
    # Fingerprint over the TAIL only: the message list virtualizes (~14 items
    # rendered), so older messages unload from the a11y tree and a full-list
    # fingerprint would churn as conversations grow.
    state['fingerprint'] = hashlib.sha1(json.dumps(
        [[m['role'], m['text'][:80]] for m in state['messages'][-12:]],
        ensure_ascii=False).encode('utf-8')).hexdigest()
    return state


# ---------------------------------------------------------------- worker

class Worker:
    def __init__(self):
        self.loop = GLib.MainLoop()
        self.clip = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        self.busy = False

    # -- transport

    def respond(self, req_id, ok, payload):
        line = json.dumps({'id': req_id, 'ok': ok, **payload}, ensure_ascii=False)
        sys.stdout.write(line + '\n')
        sys.stdout.flush()

    def dispatch(self, line):
        try:
            req = json.loads(line)
        except Exception as e:
            log('bad json line: %s' % e)
            return False
        req_id = req.get('id')
        method = req.get('method')
        params = req.get('params') or {}
        if self.busy and method != 'ping':
            self.respond(req_id, False, {'error': {
                'code': 'SIDECAR_BUSY', 'message': 'another operation is in progress', 'details': {}}})
            return False
        handler = getattr(self, 'm_' + str(method), None)
        if handler is None:
            self.respond(req_id, False, {'error': {
                'code': 'INTERNAL', 'message': 'unknown method: %s' % method, 'details': {}}})
            return False
        self.busy = True
        log('method=%s id=%s' % (method, req_id))
        self.run_gen(handler(params), req_id)
        return False

    def run_gen(self, gen, req_id):
        def step():
            try:
                delay = next(gen) if not hasattr(step, 'started') else gen.send(None)
                step.started = True
            except StopIteration as e:
                self.busy = False
                self.respond(req_id, True, {'result': e.value if e.value is not None else {}})
                return False
            except WorkerError as e:
                self.busy = False
                log('error %s: %s' % (e.code, e.message))
                self.respond(req_id, False, {'error': {
                    'code': e.code, 'message': e.message, 'details': e.details}})
                return False
            except Exception as e:  # noqa: BLE001
                self.busy = False
                log('unexpected error: %r' % e)
                self.respond(req_id, False, {'error': {
                    'code': 'INTERNAL', 'message': repr(e), 'details': {}}})
                return False
            GLib.timeout_add(max(int(delay), 0), step)
            return False
        GLib.timeout_add(0, step)

    # -- methods (generators yielding delay-ms between steps)

    def m_ping(self, p):
        yield 0
        return {'pong': True, 'protocol': PROTOCOL_VERSION}

    def m_health(self, p):
        yield 0
        proc = find_chatgpt_process()
        if proc is None:
            raise WorkerError('APP_NOT_RUNNING', 'chatgpt process not found', {})
        flag_present = A11Y_FLAG in proc['argv']
        frame = require_frame()
        entry = find_entry(frame)
        st = scan_state(frame)
        return {
            'app_running': True,
            'pid': proc['pid'],
            'a11y_flag_present': flag_present,
            'surface_found': True,
            'composer_found': entry is not None,
            'mode': st['mode'],
            'generating': st['generating'],
            'message_count': len(st['messages']),
        }

    def m_get_state(self, p):
        yield 0
        frame = require_frame()
        st = scan_state(frame)
        st['surface_found'] = True
        st['composer_found'] = find_entry(frame) is not None
        if not p.get('include_messages', True):
            st.pop('messages', None)
        return st

    def m_new_chat(self, p):
        yield 0
        frame = require_frame()
        btn = find_button(frame, NEW_CHAT_NAMES)
        if btn is None:
            raise WorkerError('COMPOSER_NOT_FOUND', 'new-chat button not found',
                              {'tried': list(NEW_CHAT_NAMES)})
        activate_chatgpt_window()
        yield 300
        if not press(btn):
            raise WorkerError('INTERNAL', 'failed to press new-chat button', {})
        yield 1500
        frame = require_frame()
        st = scan_state(frame)
        return {'composer_text': st['composer_text'],
                'message_count': len(st['messages']),
                'generating': st['generating']}

    def m_composer_set(self, p):
        text = str(p.get('text', ''))
        yield 0
        frame = require_frame()
        entry = find_entry(frame)
        if entry is None:
            raise WorkerError('COMPOSER_NOT_FOUND', 'composer entry not found', {})
        activate_chatgpt_window()
        entry.grab_focus()
        yield 400
        # If the user's IME (e.g. IBus pinyin) is in Chinese mode, a leftover
        # preedit swallows subsequent synthetic keys (they feed the preedit
        # instead of the composer). Escape cancels any active preedit and is
        # a no-op otherwise.
        xkey('Escape')
        yield 200
        saved = self.clip.wait_for_text() or ''
        try:
            # clear with retry: focus → ctrl+a → Delete → verify emptiness
            cleared = False
            for _attempt in range(3):
                frame = require_frame()
                entry = find_entry(frame)
                if entry is None:
                    raise WorkerError('COMPOSER_NOT_FOUND', 'composer entry lost', {})
                entry.grab_focus()
                yield 300
                xkey('ctrl+a')
                yield 250
                xkey('Delete')
                yield 400
                frame = require_frame()
                entry = find_entry(frame)
                if entry is not None and entry_is_empty(entry):
                    cleared = True
                    break
                log('clear attempt failed, retrying')
            if not cleared:
                raise WorkerError('COMPOSER_SET_FAILED', 'failed to clear composer', {})
            if text:
                self.clip.set_text(text, -1)
                frame = require_frame()
                entry = find_entry(frame)
                if entry is None:
                    raise WorkerError('COMPOSER_NOT_FOUND', 'composer entry lost', {})
                entry.grab_focus()
                yield 300
                xkey('Escape')
                yield 150
                xkey('ctrl+v')
                yield 900
            frame = require_frame()
            entry = find_entry(frame)
            got = collect_text(entry) if entry is not None else ''
        finally:
            try:
                self.clip.set_text(saved, -1)
            except Exception:
                pass
        yield 200
        expected = norm_text(text)
        if not expected:
            frame = require_frame()
            entry = find_entry(frame)
            if entry is None or not entry_is_empty(entry):
                raise WorkerError('COMPOSER_SET_FAILED', 'composer not empty after clear',
                                  {'actual': got})
            return {'composer_text': ''}
        if got != expected:
            raise WorkerError('COMPOSER_SET_FAILED',
                              'composer readback mismatch after paste',
                              {'expected_len': len(expected), 'actual_len': len(got)})
        return {'composer_text': got}

    def m_send(self, p):
        yield 0
        frame = require_frame()
        entry = find_entry(frame)
        if entry is None:
            raise WorkerError('COMPOSER_NOT_FOUND', 'composer entry not found', {})
        if entry_is_empty(entry):
            raise WorkerError('PROMPT_COMMIT_FAILED', 'composer is empty; nothing to send', {})
        before = scan_state(frame)
        send_btn = find_button(frame, SEND_NAMES)
        via = 'button' if send_btn is not None else 'enter'
        if send_btn is not None:
            if not press(send_btn):
                raise WorkerError('PROMPT_COMMIT_FAILED', 'press action on send button failed', {})
        else:
            activate_chatgpt_window()
            yield 200
            xkey('Return')
        # commit verification: composer cleared AND (generation started OR user message appended)
        deadline = time.monotonic() + float(p.get('commit_timeout_ms', 5000)) / 1000.0
        while time.monotonic() < deadline:
            yield 300
            try:
                st = scan_state(require_frame())
            except WorkerError:
                raise WorkerError('UNKNOWN_COMMIT_STATE', 'surface lost after send attempt', {})
            if not st['composer_text'] and (st['generating'] or st['user_count'] > before['user_count']):
                return {'committed': True, 'via': via,
                        'user_count': st['user_count'], 'generating': st['generating']}
        st = scan_state(require_frame())
        if not st['composer_text'] and st['user_count'] > before['user_count']:
            return {'committed': True, 'via': via,
                    'user_count': st['user_count'], 'generating': st['generating']}
        if st['composer_text']:
            return {'committed': False, 'via': via, 'reason': 'composer_not_cleared'}
        raise WorkerError('UNKNOWN_COMMIT_STATE',
                          'cannot determine whether the prompt was sent',
                          {'composer_empty': True,
                           'user_count_before': before['user_count'],
                           'user_count_after': st['user_count'],
                           'generating': st['generating']})

    def m_cancel(self, p):
        yield 0
        frame = require_frame()
        btn = find_button(frame, STOP_NAMES)
        if btn is None:
            return {'cancelled': False, 'reason': 'no stop button'}
        press(btn)
        yield 800
        return {'cancelled': True}

    def m_list_conversations(self, p):
        """Read-only: enumerate sidebar conversation titles (recent list)."""
        yield 0
        frame = require_frame()
        best = []

        def rec(n, depth):
            nonlocal best
            if depth > 40:
                return
            try:
                role = n.get_role_name()
            except Exception:
                return
            if role == 'list':
                titles = conv_titles_from_list(n)
                if len(titles) > len(best):
                    best = titles
            try:
                cnt = n.get_child_count()
            except Exception:
                return
            for k in range(cnt):
                try:
                    c = n.get_child_at_index(k)
                    if c is not None:
                        rec(c, depth + 1)
                except Exception:
                    pass

        rec(frame, 0)
        limit = int(p.get('limit', 50))
        return {'conversations': best[:limit], 'count': len(best)}


def main():
    worker = Worker()
    sys.stdout.write(json.dumps({'event': 'ready', 'protocol': PROTOCOL_VERSION}) + '\n')
    sys.stdout.flush()

    import threading

    def stdin_reader():
        for line in sys.stdin:
            line = line.strip()
            if line:
                GLib.idle_add(worker.dispatch, line)
        GLib.idle_add(worker.loop.quit)

    t = threading.Thread(target=stdin_reader, daemon=True)
    t.start()

    signal.signal(signal.SIGTERM, lambda *_: GLib.idle_add(worker.loop.quit))
    log('ready (pid=%d)' % os.getpid())
    worker.loop.run()


if __name__ == '__main__':
    main()
