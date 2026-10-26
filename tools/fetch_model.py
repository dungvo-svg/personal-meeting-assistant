"""Explicit setup only: download and verify the pinned public local-ASR model."""
import hashlib
import json
import os
from pathlib import Path

os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
from huggingface_hub import snapshot_download

root = Path(__file__).resolve().parents[1]
lock = json.loads((root/'config/asr-model.lock.json').read_text(encoding='utf-8'))
destination = root/'.local/models/small'
snapshot_download(lock['repo_id'], revision=lock['revision'], local_dir=destination, allow_patterns=list(lock['files']), token=False)
for name, expected in lock['files'].items():
    actual = hashlib.sha256((destination/name).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f'Model hash mismatch: {name}')
print('Pinned public ASR model verified. No audio capture or transcription was started.')
