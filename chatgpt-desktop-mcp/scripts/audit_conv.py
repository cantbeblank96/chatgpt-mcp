#!/usr/bin/env python3
"""Read-only: emit JSON {"user_count": int, "last_user": str} for the current
ChatGPT conversation. Used by the stress test audit (virtualization-safe:
duplicate sends are detected via count > expected; message identity via
last-user-text comparison).
"""
import json
import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi  # noqa: E402

USER_HEADINGS = ('你说：', '你说:', 'You said:')


def chat_frame():
    d = Atspi.get_desktop(0)
    for i in range(d.get_child_count()):
        a = d.get_child_at_index(i)
        if a and a.get_name() == 'Codex':
            for j in range(a.get_child_count()):
                f = a.get_child_at_index(j)
                if f and f.get_name() == 'ChatGPT':
                    return f


def leaf_text(node):
    out = []

    def rec(x):
        try:
            n = x.get_child_count()
        except Exception:
            n = 0
        try:
            if x.get_role_name() == 'static':
                if n == 0:
                    ti = x.get_text_iface()
                    if ti:
                        out.append(ti.get_text(0, ti.get_character_count()))
                return
        except Exception:
            pass
        for k in range(n):
            try:
                c = x.get_child_at_index(k)
                if c:
                    rec(c)
            except Exception:
                pass

    rec(node)
    return ''.join(out)


def main():
    frame = chat_frame()
    if frame is None:
        print(json.dumps({'user_count': -1, 'last_user': ''}))
        return

    # ordered (document order) list of user headings
    users = []

    def rec(n):
        try:
            role = n.get_role_name()
            if role == 'heading':
                name = n.get_name() or ''
                if any(name.startswith(h.rstrip('：:')) for h in USER_HEADINGS) or name.lower().startswith('you said'):
                    users.append(n)
        except Exception:
            pass
        for k in range(n.get_child_count()):
            try:
                c = n.get_child_at_index(k)
                if c:
                    rec(c)
            except Exception:
                pass

    rec(frame)

    last_user = ''
    if users:
        h = users[-1]
        # walk the tree in DFS order, collect paragraphs that follow the last
        # user heading until the next heading closes the segment
        def collect_after(node, state):
            for k in range(node.get_child_count()):
                try:
                    c = node.get_child_at_index(k)
                except Exception:
                    continue
                if c is None:
                    continue
                if state['found']:
                    try:
                        if c.get_role_name() == 'heading':
                            state['stop'] = True
                            return
                        if c.get_role_name() == 'paragraph':
                            t = leaf_text(c)
                            if t.strip():
                                state['texts'].append(t.strip())
                    except Exception:
                        pass
                if c == h:
                    state['found'] = True
                if not state['stop']:
                    collect_after(c, state)
                if state['stop']:
                    return

        state = {'found': False, 'stop': False, 'texts': []}
        root = frame
        collect_after(root, state)
        last_user = '\n'.join(state['texts'])[:300]

    print(json.dumps({'user_count': len(users), 'last_user': last_user}, ensure_ascii=False))


if __name__ == '__main__':
    main()
