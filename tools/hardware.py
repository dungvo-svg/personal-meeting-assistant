"""What this machine can run, read only: GPU (nvidia-smi), RAM, free disk, Windows, the models installed.

The same table on every machine (owner 21/11): the person's own Claude installs PMA, reads this verdict, installs the models
the tier needs, and `pma start` refuses a meeting the machine cannot serve. Loads no model, opens no device.

Tiers:
  day-du      Vietnamese + Lao/Thai live on the GPU (Whisper large-v3-turbo + BuzzASR Lao, both float16)
  tieng-viet  Vietnamese (and Thai) live on the GPU; no Lao model: a meeting with Lao is refused
  khong-du    not for live meetings: `pma start` refuses
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / '.local' / 'models'
GIB = 2 ** 30

# Measured 21/11 on RTX 3050 6 GB, i5-12400F, 16 GB RAM: turbo 1.5 GB + BuzzASR 2.9 GB on disk, both loaded with room left; FLEURS
# Lao pipeline real-time factor 0.26 (about 4x faster than speech). A 4 GB card holds turbo alone. WAV of a meeting: about 0.65 GB
# per hour (speaker + microphone, 44.1 kHz mono 16-bit).
FULL_VRAM_MIB, VI_VRAM_MIB = 6000, 4000
FULL_RAM_GIB, MIN_RAM_GIB = 15, 8  # a "16 GB" machine reports 15.x
MIN_DISK_GIB = 10
REQUIREMENTS = [
    {'tier': 'day-du', 'label': 'Đầy đủ: họp tiếng Việt + Lào/Thái', 'gpu': 'NVIDIA có CUDA, VRAM ≥ 6 GB', 'ram': '≥ 16 GB', 'disk': f'≥ {MIN_DISK_GIB} GB trống',
     'models': 'whisper-large-v3-turbo-ct2 (1,5 GB) + buzzasr-lao-ct2 (2,9 GB)', 'install': 'sh tools/setup_lao_gpu.sh',
     'tested': 'RTX 3050 6 GB, i5-12400F, 16 GB (21/11): nhanh khoảng 4 lần thời gian thực'},
    {'tier': 'tieng-viet', 'label': 'Chỉ họp tiếng Việt (và Thái)', 'gpu': 'NVIDIA có CUDA, VRAM 4–6 GB', 'ram': '≥ 8 GB', 'disk': f'≥ {MIN_DISK_GIB} GB trống',
     'models': 'whisper-large-v3-turbo-ct2 (1,5 GB); KHÔNG cài mô hình Lào', 'install': 'tools/convert_whisper_model.py openai/whisper-large-v3-turbo … whisper-large-v3-turbo-ct2',
     'note': 'họp có tiếng Lào bị từ chối: lời Lào sẽ ra chữ Thái phiên âm'},
    {'tier': 'khong-du', 'label': 'Không dùng cho họp trực tiếp', 'gpu': 'không có NVIDIA CUDA, hoặc VRAM < 4 GB', 'ram': '< 8 GB', 'disk': f'< {MIN_DISK_GIB} GB trống',
     'models': '—', 'install': '—', 'note': 'pma start từ chối; CPU chỉ chạy mô hình small, chậm và sai nhiều'},
]


def ram_gib():
    if os.name != 'nt':
        try:
            return os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') / GIB
        except (ValueError, OSError, AttributeError):
            return None

    class Status(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong), ('total', ctypes.c_ulonglong), ('free', ctypes.c_ulonglong),
                    ('page_total', ctypes.c_ulonglong), ('page_free', ctypes.c_ulonglong), ('virtual_total', ctypes.c_ulonglong),
                    ('virtual_free', ctypes.c_ulonglong), ('extended', ctypes.c_ulonglong)]
    status = Status(); status.length = ctypes.sizeof(Status)
    return status.total / GIB if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)) else None


def gpus():
    try:
        done = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
                              capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return []
    out = []
    for line in done.stdout.splitlines() if done.returncode == 0 else []:
        parts = [p.strip() for p in line.split(',')]
        if len(parts) >= 2 and parts[1].isdigit():
            out.append({'name': parts[0], 'vramMiB': int(parts[1]), 'driver': parts[2] if len(parts) > 2 else None})
    return out


def model_dirs():
    try:
        profile = json.loads((MODELS / 'asr-profile.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        profile = {}
    main = profile.get('main') or 'small'
    lao = profile.get('lo', 'buzzasr-lao-ct2')
    return {'main': main, 'mainInstalled': (MODELS / main).is_dir(), 'lo': lao, 'loInstalled': bool(lao) and (MODELS / lao).is_dir()}


def assess(languages=None, measured=None):
    m = measured or {'windows': os.name == 'nt', 'ramGiB': ram_gib(), 'diskFreeGiB': shutil.disk_usage(ROOT).free / GIB, 'cpus': os.cpu_count(), 'gpus': gpus(), 'models': model_dirs()}
    vram = max((g['vramMiB'] for g in m['gpus']), default=0)
    ram = m['ramGiB'] or 0
    short = []
    if not m['windows']:
        short.append('không phải Windows: bộ ghi dùng loa loopback WASAPI của Windows')
    if vram < VI_VRAM_MIB:
        short.append('không có card NVIDIA có CUDA' if not m['gpus'] else f'VRAM {vram} MiB < {VI_VRAM_MIB} MiB')
    if ram < MIN_RAM_GIB:
        short.append(f'RAM {ram:.1f} GB < {MIN_RAM_GIB} GB')
    if m['diskFreeGiB'] < MIN_DISK_GIB:
        short.append(f'đĩa trống {m["diskFreeGiB"]:.0f} GB < {MIN_DISK_GIB} GB (WAV cả buổi khoảng 0,65 GB/giờ)')
    if short:
        tier = 'khong-du'
    elif vram >= FULL_VRAM_MIB and ram >= FULL_RAM_GIB:
        tier = 'day-du'
    else:
        tier = 'tieng-viet'
    why_vi_only = [] if tier != 'tieng-viet' else ([f'VRAM {vram} MiB < {FULL_VRAM_MIB} MiB'] if vram < FULL_VRAM_MIB else []) + ([f'RAM {ram:.1f} GB < 16 GB'] if ram < FULL_RAM_GIB else [])
    lao_ok = tier == 'day-du' and m['models']['loInstalled']
    allowed = [] if tier == 'khong-du' else ['vi', 'th'] + (['lo'] if lao_ok else [])
    verdict = {'tier': tier, 'label': next(r['label'] for r in REQUIREMENTS if r['tier'] == tier), 'allowedLanguages': allowed,
               'reasons': short or why_vi_only, 'measured': m, 'requirements': REQUIREMENTS}
    if tier == 'day-du' and not m['models']['loInstalled']:
        verdict['reasons'] = ['máy đủ cho tiếng Lào nhưng chưa cài mô hình Lào: sh tools/setup_lao_gpu.sh']
    if not m['models']['mainInstalled']:
        verdict['reasons'] = verdict['reasons'] + [f"chưa có mô hình chính {m['models']['main']}"]
    if languages is not None:
        wanted = [code for code in languages if code]
        refused = [code for code in wanted if code not in allowed]
        verdict['meeting'] = {'languages': wanted, 'ok': not refused and tier != 'khong-du', 'refused': refused}
    return verdict


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--languages', help='languages of the meeting to check, e.g. vi,lo,th')
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    v = assess(args.languages.split(',') if args.languages else None)
    if args.json:
        print(json.dumps(v, ensure_ascii=False))
    else:
        m = v['measured']
        print(f"Máy: {', '.join(g['name'] + ' ' + str(g['vramMiB']) + ' MiB' for g in m['gpus']) or 'không có NVIDIA'} · RAM {m['ramGiB'] or 0:.1f} GB · đĩa trống {m['diskFreeGiB']:.0f} GB · {m['cpus']} luồng CPU")
        print(f"Bậc: {v['tier']} — {v['label']}" + (f" ({'; '.join(v['reasons'])})" if v['reasons'] else ''))
        print('Ngôn ngữ dùng được: ' + (', '.join(v['allowedLanguages']) or 'không'))
        print('\n| Bậc | Dùng cho | GPU | RAM | Đĩa | Mô hình |\n| --- | --- | --- | --- | --- | --- |')
        for r in REQUIREMENTS:
            print(f"| {r['tier']} | {r['label']} | {r['gpu']} | {r['ram']} | {r['disk']} | {r['models']} |")
