#!/usr/bin/env python3
"""Manually drive atspi_worker.py over JSONL for debugging."""
import json, subprocess, sys, time

worker = sys.argv[1] if len(sys.argv) > 1 else 'dist/adapters/atspi/python/atspi_worker.py'
p = subprocess.Popen(['/usr/bin/python3', worker], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=sys.stderr, text=True, bufsize=1)
ready = p.stdout.readline()
print('READY:', ready.strip())

def call(method, params=None):
    req = json.dumps({'id': int(time.time()*1000) % 10**9, 'method': method, 'params': params or {}}, ensure_ascii=False)
    p.stdin.write(req + '\n'); p.stdin.flush()
    line = p.stdout.readline()
    print(f'--- {method} ->', line.strip()[:600])
    return json.loads(line)

seq = sys.argv[2] if len(sys.argv) > 2 else 'set'
if seq == 'state':
    call('get_state')
elif seq == 'set':
    call('composer_set', {'text': '诊断测试：只读回不发送'})
elif seq == 'set2':
    call('composer_set', {'text': '第二次设置，验证清空'})
elif seq == 'clear':
    call('composer_set', {'text': ''})
p.terminate()
