"""Download a Whisper-family model from Hugging Face at a pinned revision and convert it to CTranslate2.
For models with the standard Whisper vocabulary (whisper-large-v3-turbo, PhoWhisper). BuzzASR/lao replaces the
vocabulary and has its own converter (convert_lao_model.py). Run with .local/convert-venv."""
import argparse
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repo')
    parser.add_argument('revision')
    parser.add_argument('name', help='output folder under .local/models')
    args = parser.parse_args()
    from ctranslate2.converters import TransformersConverter
    from huggingface_hub import snapshot_download
    from transformers import WhisperTokenizerFast
    source = Path(snapshot_download(args.repo, revision=args.revision, local_dir=str(root / '.local' / 'models' / 'src' / args.name)))
    tokenizer = WhisperTokenizerFast.from_pretrained(str(source))
    if not (source / 'tokenizer.json').exists():
        tokenizer.save_pretrained(str(source))
    # Standard vocabulary only: the prompt tokens must keep Whisper's ids, otherwise the decoder gets a wrong prompt.
    ids = {name: tokenizer.convert_tokens_to_ids(name) for name in ('<|endoftext|>', '<|startoftranscript|>', '<|vi|>', '<|transcribe|>', '<|notimestamps|>')}
    if ids['<|endoftext|>'] != 50257 or ids['<|startoftranscript|>'] != 50258:
        raise SystemExit(f'Non-standard vocabulary {ids}; write a dedicated converter')
    target = root / '.local' / 'models' / args.name
    TransformersConverter(str(source), copy_files=['tokenizer.json', 'preprocessor_config.json'], low_cpu_mem_usage=True).convert(str(target), quantization='float16', force=True)
    config = json.loads((target / 'config.json').read_text(encoding='utf-8'))
    print(json.dumps({'converted': str(target), 'revision': args.revision, 'tokens': ids, 'languages': len(config.get('lang_ids') or [])}))


if __name__ == '__main__':
    main()
