"""Print the MCP server entry for a host. Read-only: writes no config, starts nothing."""

import argparse
import json
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('host', choices=['claude-code', 'claude-desktop', 'codex', 'antigravity'])
parser.add_argument('--node', default=shutil.which('node') or 'node')
args = parser.parse_args()

command = str(Path(args.node).resolve()) if Path(args.node).exists() else args.node
server = str(root / 'dist' / 'server.js')
env = {'PMA_PYTHON': str(root / '.venv' / 'Scripts' / 'python.exe'), 'PMA_DATA_DIR': str(root / '.local' / 'runtime'), 'PMA_PORT': '8796'}
name = 'personal-meeting-assistant'

if args.host == 'claude-code':
    flags = ' '.join(f'-e "{k}={v}"' for k, v in env.items())
    print(f'claude mcp add --scope local {name} {flags} -- "{command}" "{server}"')
elif args.host == 'codex':
    # Codex reads ~/.codex/config.toml. source_next waits up to 25 s, so the tool timeout must exceed it.
    toml = lambda value: json.dumps(value, ensure_ascii=False)
    print(f'[mcp_servers.{name}]')
    print(f'command = {toml(command)}')
    print(f'args = [{toml(server)}]')
    print('tool_timeout_sec = 60')
    print(f'[mcp_servers.{name}.env]')
    for key, value in env.items():
        print(f'{key} = {toml(value)}')
else:
    # Claude Desktop (claude_desktop_config.json) and Antigravity (mcp_config.json) share the mcpServers shape.
    print(json.dumps({'mcpServers': {name: {'command': command, 'args': [server], 'env': env}}}, ensure_ascii=False, indent=2))
