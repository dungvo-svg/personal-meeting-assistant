"""Transcribe recordings on this machine (meetings, WhatsApp voice notes .opus/.ogg, .m4a, .mp3, .wav) into one Markdown file.

No audio is written; nothing leaves the machine. Same models and filters as the live meeting worker (Vietnamese, Lao, Thai);
invented sentences (silence phrases, Lao news stock phrases at low confidence) are dropped and counted, not shown as text.
`pma transcribe <files…>` runs this (owner 21/11: tool for Lê Hoàng Duy's WhatsApp / app recordings)."""
import argparse
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audio_worker import asr_profile, chunk_alternatives, collapse_repeats, load_models, load_recording, segment_flags, transcribe_chunk  # noqa: E402  (same choices and filters as the live worker)

LABELS = {'LAO_WRITTEN_IN_THAI_SCRIPT': 'chữ Thái, nội dung không đáng tin', 'LIKELY_HALLUCINATION': 'nghi câu ảo', 'REPETITION': 'lặp từ',
          'LANG_UNSURE': 'ngôn ngữ không chắc', 'LAO_LOW_CONFIDENCE': 'Lào kém', 'LAO_MODEL_MISSING': 'thiếu mô hình Lào: chữ Thái phiên âm'}

def speech_chunks(audio, max_seconds=20.0, join_gap=1.0):
    # Cut at pauses in speech (Silero VAD), merging short turns up to max_seconds.
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    regions = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=500, speech_pad_ms=200))
    rate, limit, gap = 16000, int(max_seconds * 16000), int(join_gap * 16000)
    chunks = []
    for region in regions:
        start, end = region['start'], region['end']
        while end - start > limit:
            chunks.append([start, start + limit])
            start += limit
        if chunks and start - chunks[-1][1] <= gap and end - chunks[-1][0] <= limit:
            chunks[-1][1] = end
        else:
            chunks.append([start, end])
    return [(s / rate, e / rate) for s, e in chunks]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('files', nargs='+', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--title', default='Cuộc họp')
    parser.add_argument('--languages', default='vi,lo,th')
    parser.add_argument('--model', type=Path, help='main model (default: asr-profile.json)')
    parser.add_argument('--vi-model', type=Path)
    parser.add_argument('--device', default='auto', choices=['auto', 'cuda', 'cpu'])
    parser.add_argument('--lao-model', type=Path)
    parser.add_argument('--threads', type=int, default=10)
    args = parser.parse_args()
    languages = args.languages.split(',')
    profile = asr_profile()
    model, lao_model, vi_model, asr = load_models(args.model or profile['main'], args.lao_model or profile['lo'], args.device, args.threads, args.vi_model or profile['vi'])
    print(f'ASR: {asr}', file=sys.stderr, flush=True)
    lines, counter, stats = [], 0, Counter()
    stats['audioSeconds'] = 0.0
    started = time.monotonic()
    for path in args.files:
        match = re.search(r'(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2})', path.name)
        base = datetime.strptime(' '.join(match.groups()), '%Y-%m-%d %H %M %S') if match else None
        audio = load_recording(path)
        stats['audioSeconds'] += len(audio) / 16000
        chunks = speech_chunks(audio)
        lines += ['', f'## {path.name}' + (f' — bắt đầu {base:%H:%M:%S}' if base else ''), '']
        for index, (begin, end) in enumerate(chunks, 1):
            segments, language, probability = transcribe_chunk(model, audio[int(begin * 16000):int(end * 16000)], languages, lao_model, vi_model)
            # The other Lao/Thai reading of an unsure chunk, printed under its first line (21/11: real Lao came out as Thai-script
            # transliteration here while the Lao reading of the same stretch was right; Claude translates from both).
            others = chunk_alternatives(segments)
            for segment in segments:
                text = segment.text.strip()
                if not text:
                    continue
                flags = segment_flags(text, segment, language, probability)
                if lao_model is None and 'lo' in languages and language in ('lo', 'th'):
                    flags.append('LAO_MODEL_MISSING')
                if 'LIKELY_HALLUCINATION' in flags:
                    stats['dropped'] += 1
                    continue  # an invented sentence is not part of what was said
                counter += 1
                marks = [LABELS[flag] for flag in flags if flag in LABELS]
                stats[language] += 1
                stats['flagged'] += bool(marks)
                at = begin + segment.start
                clock = f'{base + timedelta(seconds=at):%H:%M:%S}' if base else f'+{at:7.1f}s'
                lines.append(f'[{clock}] #{counter} ({language}{" · " + "; ".join(marks) if marks else ""}) {collapse_repeats(text)}')
                for other in others or []:
                    lines.append(f'  ↳ {other["language"]} (cách đọc khác, điểm {other["score"]}): {other["text"]}')
                others = None
            print(f'{path.name}: {index}/{len(chunks)} chunks, {counter} lines, {time.monotonic() - started:.0f}s', file=sys.stderr, flush=True)
        del audio
    header = [f'# RAW transcript — {args.title}', '',
              f'Nhận dạng từ {len(args.files)} file ghi âm/ghi hình, chạy trên máy (faster-whisper {asr['mainModel']}{' + ' + asr['viModel'] + ' cho tiếng Việt' if asr['viModel'] else ''}{' + ' + asr['laoModel'] + ' cho tiếng Lào' if asr['laoModel'] else ''}, {asr['device']}). Âm thanh không được lưu thêm, không gửi đi đâu.',
              f'Âm thanh {stats["audioSeconds"] / 60:.1f} phút · {counter} dòng · tiếng Việt {stats["vi"]} · tiếng Lào {stats["lo"]} · tiếng Thái {stats["th"]} · gắn cờ {stats["flagged"]} · bỏ câu bịa {stats["dropped"]} · xử lý {(time.monotonic() - started) / 60:.1f} phút.', '',
              '> Văn bản ASR CHƯA xác minh. Giờ = giờ bắt đầu file ghi hình + vị trí trong file. Nhãn vi/lo do máy chọn từng đoạn, có thể sai ở chỗ chuyển ngôn ngữ. Không có model tiếng Lào (cần GPU) thì tiếng Lào thường bị ghi thành chữ Thái phiên âm, nghĩa không đáng tin.']
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text('\n'.join(header + lines) + '\n', encoding='utf-8')
    print(f'DONE {args.out} lines={counter} vi={stats["vi"]} lo={stats["lo"]} th={stats["th"]} flagged={stats["flagged"]} dropped={stats["dropped"]}', file=sys.stderr)


if __name__ == '__main__':
    main()
