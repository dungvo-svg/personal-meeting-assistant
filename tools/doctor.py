"""`pma doctor`: what this machine has for the meeting tool, read-only. Starts no host, no capture, no model load.

Each check says Available or what is missing, and how to fix it. The same list on every machine (owner 11/11: one tool,
one check), so a second machine (a class at NNC) is set up against it. Exit code 1 when a required check fails.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--json', action='store_true', help='the full report as JSON')
parser.add_argument('--project', type=Path, default=Path.cwd(), help='the project folder a meeting session runs in (its hop skill and Stop hook)')
args = parser.parse_args()
sys.stdout.reconfigure(encoding='utf-8')  # Vietnamese text on a Windows console
venv = root / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
models = root / '.local' / 'models'
checks = []


def check(name, ok, detail, fix=None, required=True):
    checks.append({'name': name, 'ok': bool(ok), 'required': required, 'detail': detail, **({'fix': fix} if fix and not ok else {})})


def run(command, timeout=20):
    try:
        done = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
        return done.returncode, done.stdout.strip(), done.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return -1, '', str(exc)


# pma itself
package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
code, commit, _ = run(['git', '-C', str(root), 'rev-parse', '--short', 'HEAD'])
check('pma', True, f"{package.get('version')} ({commit if code == 0 else 'không có git'}) tại {root.as_posix()}")
code, node, _ = run(['node', '--version'])
need = package.get('engines', {}).get('node', '').lstrip('>=')
version = lambda text: tuple(int(x) for x in text.lstrip('v').split('.')[:3] if x.isdigit())
check('node', code == 0 and version(node) >= version(need or '0'), node or 'không thấy node', f'cài Node {need} trở lên')
check('build', (root / 'dist/cli.js').is_file() and (root / 'dist/daemon.js').is_file(), 'dist/cli.js, dist/daemon.js', f'npm run build (trong {root.as_posix()})')

# Python and the audio stack
check('python .venv', venv.is_file(), venv.as_posix(), 'tạo .venv và cài gói theo README')
if venv.is_file():
    probe = ("import importlib, json; out = {}\n"
             "for name in ('numpy', 'av', 'pyaudiowpatch', 'ctranslate2', 'faster_whisper'):\n"
             "    try: importlib.import_module(name); out[name] = True\n"
             "    except Exception as exc: out[name] = str(exc)[:120]\n"
             "try:\n    import ctranslate2; out['cuda_devices'] = ctranslate2.get_cuda_device_count()\n"
             "except Exception: out['cuda_devices'] = 0\n"
             "print(json.dumps(out))")
    code, out, err = run([str(venv), '-c', probe], timeout=60)
    found = json.loads(out) if code == 0 and out.startswith('{') else {}
    missing = [name for name in ('numpy', 'av', 'pyaudiowpatch', 'ctranslate2', 'faster_whisper') if found.get(name) is not True]
    check('gói Python', not missing, 'đủ' if not missing else 'thiếu: ' + ', '.join(missing), f'{venv.as_posix()} -m pip install ' + ' '.join(missing))
    check('CUDA', found.get('cuda_devices', 0) > 0, f"{found.get('cuda_devices', 0)} thiết bị CUDA cho CTranslate2", 'cài driver NVIDIA và bản CUDA của ctranslate2; không có thì ASR chạy CPU, chậm', required=False)
code, gpu, _ = run(['nvidia-smi', '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'])
check('GPU', code == 0 and bool(gpu), gpu or 'không thấy nvidia-smi', 'cài driver NVIDIA', required=False)

# Models: the lock of Whisper small, and every folder the ASR profile names
lock = json.loads((root / 'config/asr-model.lock.json').read_text(encoding='utf-8'))
small = {name: (models / 'small' / name).is_file() and hashlib.sha256((models / 'small' / name).read_bytes()).hexdigest() == digest for name, digest in lock['files'].items()}
check('mô hình small', all(small.values()), 'khớp mã băm' if all(small.values()) else 'thiếu/lệch: ' + ', '.join(n for n, ok in small.items() if not ok), 'python tools/fetch_model.py')
try:
    profile = json.loads((models / 'asr-profile.json').read_text(encoding='utf-8'))
except (OSError, ValueError):
    profile = {}
for role in ('main', 'vi', 'lo'):
    name = profile.get(role) or {'main': 'small', 'lo': 'buzzasr-lao-ct2'}.get(role)
    if name:
        there = (models / name).is_dir()
        # 21/11 (owner + Oanh): without the Lao model, spoken Lao comes out as a Thai-script transliteration (ENG-13: CER 100%).
        detail = name if there or role != 'lo' else f'{name}: KHÔNG CÓ, tiếng Lào sẽ ra chữ Thái phiên âm, nghĩa/số/tên không đáng tin'
        fix = 'sh tools/setup_lao_gpu.sh (tải ~3 GB, chuyển đổi 30 phút tới vài giờ; chạy ngoài giờ họp)' if role == 'lo' else f'tải hoặc chuyển đổi mô hình vào {(models / name).as_posix()} (tools/fetch_model.py, tools/convert_*.py)'
        check(f'mô hình {role}', there, detail, fix, required=role == 'main')
lao_missing = any(c['name'] == 'mô hình lo' and not c['ok'] for c in checks)

# The hardware tier (tools/hardware.py, owner 21/11): the installer — the person's own Claude — installs the models of that tier,
# and `pma start` refuses what the machine cannot serve.
sys.path.insert(0, str(root / 'tools'))
import hardware  # noqa: E402
tier = hardware.assess()
m = tier['measured']
machine = f"{', '.join(g['name'] + ' ' + str(g['vramMiB']) + ' MiB' for g in m['gpus']) or 'không có NVIDIA'}, RAM {m['ramGiB'] or 0:.1f} GB"
check('phần cứng', tier['tier'] != 'khong-du', f"{tier['tier']} — {tier['label']} ({machine})" + (f": {'; '.join(tier['reasons'])}" if tier['reasons'] else ''),
      'không dùng máy này cho họp trực tiếp; bảng yêu cầu: pma hardware')
if tier['tier'] == 'tieng-viet':
    lao_missing = True  # the card cannot hold the Lao model: Lao meetings are refused whatever is installed

# Sound sources (listed, never opened for capture)
if venv.is_file():
    code, out, err = run([str(venv), str(root / 'tools/audio_worker.py'), '--list'], timeout=30)
    try:
        sources = json.loads(out) if code == 0 else []
    except ValueError:
        sources = []
    speakers = [s['name'] for s in sources if s.get('kind') != 'microphone']
    mics = [s['name'] for s in sources if s.get('kind') == 'microphone']
    check('nguồn loa', bool(speakers), f'{len(speakers)}: ' + '; '.join(speakers[:4]) if speakers else (err[-200:] or 'không thấy'), 'kiểm thiết bị âm thanh Windows (loa loopback WASAPI)')
    check('micro', bool(mics), f'{len(mics)}: ' + '; '.join(mics[:3]) if mics else 'không thấy', 'cắm micro hoặc bật trong Windows', required=False)

# Disk, ffmpeg (PyAV is used; ffmpeg is not needed)
free = shutil.disk_usage(root).free / 2**30
check('đĩa', free >= 5, f'{free:.0f} GB trống', 'giải phóng đĩa: WAV cả buổi khoảng 0,5 GB/giờ', required=False)
check('ffmpeg', shutil.which('ffmpeg') is not None, shutil.which('ffmpeg') or 'không có (không cần: dùng PyAV)', None, required=False)

# The host now, and who holds the machine (read only)
data_dir = Path(os.environ.get('PMA_DATA_DIR') or root / '.local/runtime')
host = 'không chạy'
try:
    daemon = json.loads((data_dir / 'daemon.json').read_text(encoding='utf-8'))
    request = urllib.request.Request(daemon['url'] + '/rpc', data=json.dumps({'method': 'status'}).encode('utf-8'), method='POST', headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + daemon['token']})
    with urllib.request.urlopen(request, timeout=2) as response:
        reply = json.loads(response.read().decode('utf-8'))
    session = (reply.get('result') or {}).get('session') or {}
    host = f"pid {daemon.get('pid')}, bản {daemon.get('version')}, " + (f"đang họp: {session.get('title')}" if session and not session.get('ended') else 'không có cuộc họp mở')
except (OSError, ValueError, KeyError):
    pass
check('host', True, host, required=False)
lock_dir = Path(os.environ.get('PMA_LOCK_DIR') or Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'pma')
try:
    holder = json.loads((lock_dir / 'runtime.lock').read_text(encoding='utf-8'))
    check('khoá máy', True, f"giữ bởi pid {holder.get('pid')} ({holder.get('dataDir')})", required=False)
except (OSError, ValueError):
    check('khoá máy', True, 'trống', required=False)

# The project a meeting session runs in: the hop skill (a pointer to `pma guide` of THIS pma) and the Stop hook.
# `pma connect --project <folder>` writes both with this machine's paths (owner 25/11: nothing hard-coded).
project = args.project.resolve()
skill = project / '.claude/skills/hop/SKILL.md'
text = skill.read_text(encoding='utf-8') if skill.is_file() else ''
norm = lambda value: value.replace('\\', '/').lower()
here = norm(root.resolve().as_posix())
is_root = norm(project.as_posix()) == here
points_here = f'"{here}/pma" guide' in norm(text) or (is_root and '"./pma" guide' in text)
connect_fix = f'"{root.as_posix()}/pma" connect --project "{project.as_posix()}"'
check('kỹ năng hop', points_here, f'{project.as_posix()}: ' + ('trỏ tới pma guide của bản này' if points_here else 'trỏ tới bản pma khác' if 'pma" guide' in text else 'bản cũ chép cả quy trình' if text else 'chưa có'),
      connect_fix, required=False)
settings_text = ''.join((project / '.claude' / name).read_text(encoding='utf-8') for name in ('settings.json', 'settings.local.json') if (project / '.claude' / name).is_file())
hook = f'{here}/tools/meeting_stop_hook.mjs' in norm(settings_text).replace('//', '/')
check('Stop hook', hook, project.as_posix() + ('' if hook else ' (trỏ tới bản pma khác)' if 'meeting_stop_hook' in settings_text else ''), connect_fix, required=False)

failed = [c for c in checks if c['required'] and not c['ok']]
if args.json:
    print(json.dumps({'ready': not failed, 'laoReady': not lao_missing, 'hardware': {k: tier[k] for k in ('tier', 'label', 'allowedLanguages', 'reasons')}, 'checks': checks, 'meaning': 'Files, packages, devices listed and configuration only; nothing was recorded, transcribed or started.'}, ensure_ascii=False, indent=2))
else:
    for c in checks:
        mark = 'OK  ' if c['ok'] else ('THIẾU' if c['required'] else 'chú ý')
        print(f"{mark} {c['name']}: {c['detail']}" + (f"  → {c['fix']}" if c.get('fix') else ''))
    print(('SẴN SÀNG' + ((' cho tiếng Việt; máy CHỈ đủ tiếng Việt (bậc tieng-viet)' if tier['tier'] == 'tieng-viet' else ' cho tiếng Việt; CHƯA cho tiếng Lào (thiếu mô hình Lào)') if lao_missing else '')) if not failed else f"CHƯA SẴN SÀNG: thiếu {', '.join(c['name'] for c in failed)}")
sys.exit(1 if failed else 0)
