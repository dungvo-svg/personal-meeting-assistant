"""Local read-only readiness report; does not start Claude, capture or inference."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request

root = Path(__file__).resolve().parents[1]
python = root/'.venv/Scripts/python.exe'
report = {'runtime_build_present': (root/'dist/server.js').is_file(), 'audio_python_present': python.is_file(), 'device_capture_performed': False, 'claude_tool_execution_verified': False}
lock = json.loads((root/'config/asr-model.lock.json').read_text(encoding='utf-8'))
report['asr_model_files'] = {name: (root/'.local/models/small'/name).is_file() and hashlib.sha256((root/'.local/models/small'/name).read_bytes()).hexdigest() == expected for name, expected in lock['files'].items()}
if python.is_file():
    probe = subprocess.run([str(python), str(root/'tools/audio_worker.py'), '--list'], capture_output=True, text=True, encoding='utf-8', timeout=20)
    report['source_enumeration'] = json.loads(probe.stdout) if probe.returncode == 0 else {'error': probe.stderr[-1000:]}
config = Path(os.environ['LOCALAPPDATA'])/'Claude-Data/claude_pzs8sxrjxfjjc/claude_desktop_config.json'
if config.is_file():
    entry = json.loads(config.read_text(encoding='utf-8-sig')).get('mcpServers', {}).get('personal-meeting-assistant')
    report['claude_entry_points_to_this_build'] = bool(entry and str(root/'dist/server.js') in entry.get('args', []))
else:
    report['claude_entry_points_to_this_build'] = False
# The runtime host is reached over POST /rpc with the token in daemon.json (no web panel, no fixed port).
data_dir = Path(os.environ.get('PMA_DATA_DIR') or root/'.local/runtime')
report['host_responding'] = False
try:
    daemon = json.loads((data_dir/'daemon.json').read_text(encoding='utf-8'))
    request = urllib.request.Request(daemon['url'] + '/rpc', data=json.dumps({'method': 'status'}).encode('utf-8'), method='POST', headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + daemon['token']})
    with urllib.request.urlopen(request, timeout=2) as response:
        reply = json.loads(response.read().decode('utf-8'))
    report['host_responding'] = response.status == 200 and reply.get('ok') is True
    if report['host_responding']:
        report['host'] = {'version': daemon.get('version'), 'pid': daemon.get('pid'), 'capture_state': reply['result'].get('captureState'), 'session_open': bool(reply['result'].get('session')) and not reply['result']['session'].get('ended')}
except (OSError, ValueError, KeyError):
    pass
receipt = data_dir/'client-connection.json'
report['mcp_initialization_receipt'] = json.loads(receipt.read_text(encoding='utf-8')) if receipt.is_file() else None
report['meaning'] = 'Installed files/config and device enumeration only. A connection receipt is not evidence that Claude executed tools or that device capture/meeting assistance worked.'
print(json.dumps(report, ensure_ascii=True, indent=2))
