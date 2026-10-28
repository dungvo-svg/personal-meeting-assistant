#!/bin/sh
# One-time setup for GPU ASR (Vietnamese: Whisper large-v3-turbo; Lao: BuzzASR/lao) on an NVIDIA GPU. Everything stays on this machine under the ignored .local/.
# Open-source only: CUDA runtime wheels (NVIDIA redistributable), BuzzASR/lao (MIT), FLEURS (CC-BY-4.0, scoring only).
set -e
cd "$(dirname "$0")/.."
PY=.venv/Scripts/python.exe
export HF_HUB_DISABLE_TELEMETRY=1 HF_HOME="$PWD/.local/hf-cache"

echo "== [1/5] CUDA runtime libraries for CTranslate2"
"$PY" -m pip install --disable-pip-version-check -q -r requirements-gpu.lock.txt

echo "== [2/5] BuzzASR/lao source weights (MIT, ~3 GB), pinned revision"
"$PY" -c "from huggingface_hub import snapshot_download; print(snapshot_download('BuzzASR/lao', revision='14f66e21cb0b75424281ffc22ae418b220d540bc', local_dir='.local/models/src/buzzasr-lao'))"

echo "== [3/5] FLEURS lo_la + vi_vn test sets (CC-BY-4.0) for scoring"
"$PY" -c "
from huggingface_hub import hf_hub_download
for lang in ('lo_la', 'vi_vn'):
    for name in (f'data/{lang}/test.tsv', f'data/{lang}/audio/test.tar.gz'):
        print(hf_hub_download('google/fleurs', name, repo_type='dataset', local_dir='.local/eval/fleurs'))"

echo "== [4/5] Conversion-only venv (torch CPU + transformers); the runtime venv stays small"
[ -x .local/convert-venv/Scripts/python.exe ] || "$PY" -m venv .local/convert-venv
.local/convert-venv/Scripts/python.exe -m pip install --disable-pip-version-check -q torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu
.local/convert-venv/Scripts/python.exe -m pip install --disable-pip-version-check -q transformers==5.21.0 ctranslate2==4.8.4 tokenizers==0.23.3

echo "== [5/5] Convert to CTranslate2 (Lao model + Whisper large-v3-turbo, MIT) and score"
HF_HUB_OFFLINE=1 .local/convert-venv/Scripts/python.exe tools/convert_lao_model.py
.local/convert-venv/Scripts/python.exe tools/convert_whisper_model.py openai/whisper-large-v3-turbo 41f01f3fe87f28c78e2fbf8b568835947dd65ed9 whisper-large-v3-turbo-ct2
[ -f .local/models/asr-profile.json ] || cp config/asr-profile.example.json .local/models/asr-profile.json
PYTHONIOENCODING=utf-8 "$PY" tools/eval_asr.py --model .local/models/whisper-large-v3-turbo-ct2 --pipeline-lao-model .local/models/buzzasr-lao-ct2 --language lo --limit 40 --label pipeline
echo "== DONE"
