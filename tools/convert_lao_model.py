"""Convert BuzzASR/lao (MIT, Whisper large-v3 fine-tune) to CTranslate2 so faster-whisper can run it.
Run with the conversion venv (.local/convert-venv), which has torch + transformers; the runtime venv does not."""
import json
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
source = root / '.local' / 'models' / 'src' / 'buzzasr-lao'
target = root / '.local' / 'models' / 'buzzasr-lao-ct2'


def fix_tokenizer(path, added):
    # BuzzASR replaced the BPE vocabulary for Lao. Its vocab.json still carries Whisper's special names at low
    # ids (<|endoftext|> = 0 ...), but the model uses the added-token ids (<|endoftext|> = 51865, <|lo|> = 51944).
    # A rebuilt fast tokenizer resolves names to the low ids, so the decoder gets a wrong prompt and emits nothing.
    data = json.loads(path.read_text(encoding='utf-8'))
    vocab = data['model']['vocab']
    for name in added:
        if name in vocab:
            low_id = vocab.pop(name)
            vocab[f'<|reserved_{low_id}|>'] = low_id
    data['added_tokens'] = [{'id': token_id, 'content': name, 'single_word': False, 'lstrip': False, 'rstrip': False, 'normalized': False, 'special': True}
                            for name, token_id in sorted(added.items(), key=lambda item: item[1])]
    for name, spec in ((data.get('post_processor') or {}).get('special_tokens') or {}).items():
        if name in added:
            spec['ids'] = [added[name]]
    path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')


def fix_config(path, added, space_id):
    # faster-whisper treats a model without language ids as English-only and drops the <|lo|> prompt token.
    config = json.loads(path.read_text(encoding='utf-8'))
    config['lang_ids'] = sorted(token_id for name, token_id in added.items() if 2 <= len(name) - 4 <= 3 and name[2:-2].isalpha() and name[2:-2].islower()
                                and token_id < added['<|translate|>'])
    config['suppress_ids_begin'] = [space_id, added['<|endoftext|>']]
    path.write_text(json.dumps(config, indent=2), encoding='utf-8')
    return config['lang_ids']


def main():
    from ctranslate2.converters import TransformersConverter
    from transformers import WhisperTokenizerFast
    added = json.loads((source / 'added_tokens.json').read_text(encoding='utf-8'))
    tokenizer = WhisperTokenizerFast.from_pretrained(str(source))
    space_id = tokenizer.convert_tokens_to_ids('Ġ')
    tokenizer.save_pretrained(str(source))
    fix_tokenizer(source / 'tokenizer.json', added)
    TransformersConverter(str(source), copy_files=['tokenizer.json', 'preprocessor_config.json'], low_cpu_mem_usage=True).convert(str(target), quantization='float16', force=True)
    shutil.copy(source / 'generation_config.json', target / 'source_generation_config.json')
    languages = fix_config(target / 'config.json', added, space_id)
    print('converted to', target, '| language tokens', len(languages), '| <|lo|> in list', added['<|lo|>'] in languages)


if __name__ == '__main__':
    main()
