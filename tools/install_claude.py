"""Merge this project's MCP entry into an explicit Claude config; keep a private backup."""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--config', required=True, type=Path)
parser.add_argument('--node', required=True, type=Path)
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
if args.apply and os.name == 'nt':
    probe = subprocess.run(['powershell.exe', '-NoProfile', '-Command', "@(Get-Process Claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*WindowsApps\\Claude_*\\app\\Claude.exe' }).Count"], capture_output=True, text=True, timeout=15)
    if probe.returncode != 0 or not probe.stdout.strip().isdigit():
        raise SystemExit('Cannot verify Claude Desktop is closed; no config changed.')
    if int(probe.stdout.strip()) != 0:
        raise SystemExit('CLAUDE_STILL_RUNNING: fully quit Claude before applying; its settings cache may overwrite external edits. No config changed.')
root = Path(__file__).resolve().parents[1]
config = args.config.resolve(strict=True)
node = args.node.resolve(strict=True)
assert config.name == 'claude_desktop_config.json', 'Select the Claude desktop MCP config, not another settings file'
assert (root/'dist/server.js').is_file() and (root/'.venv/Scripts/python.exe').is_file(), 'Build and install local dependencies first'
before = config.read_bytes()
data = json.loads(before.decode('utf-8-sig'))
entry = {'command': str(node), 'args': [str(root/'dist/server.js')], 'env': {'PMA_PYTHON': str(root/'.venv/Scripts/python.exe'), 'PMA_DATA_DIR': str(root/'.local/runtime'), 'PMA_PORT': '8796'}}
servers = data.setdefault('mcpServers', {})
previous = servers.get('personal-meeting-assistant')
if previous is not None and previous != entry:
    raise SystemExit('Existing personal-meeting-assistant entry differs; review it before replacement')
servers['personal-meeting-assistant'] = entry
if args.apply:
    backup_dir = root/'.local/backups'
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = backup_dir/f'claude-config-{stamp}-{uuid.uuid4().hex[:8]}.json'
    backup.write_bytes(before)
    if config.read_bytes() != before:
        raise SystemExit('Claude config changed during preparation; nothing replaced')
    temporary = config.with_name(config.name+'.pma-'+uuid.uuid4().hex+'.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8', newline='\n')
    os.replace(temporary, config)
    verified = json.loads(config.read_text(encoding='utf-8'))
    assert verified['mcpServers']['personal-meeting-assistant'] == entry
    print(json.dumps({'status':'CONFIG_ENTRY_INSTALLED_NOT_HOST_VERIFIED','config':str(config),'backup':str(backup),'original_sha256':hashlib.sha256(before).hexdigest(),'other_server_count':len(servers)-1},ensure_ascii=True))
else:
    print(json.dumps({'status':'PLAN_ONLY','config':str(config),'server_name':'personal-meeting-assistant','entry':entry,'other_server_count':len(servers)-1},ensure_ascii=False))
