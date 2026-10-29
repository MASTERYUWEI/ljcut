"""Transcribe a media copy using LJ Cut's existing local ASR service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--device', choices=['cpu', 'cuda'], default='cpu')
    args = parser.parse_args()
    os.environ['HF_HUB_OFFLINE'] = '1'
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
    from services.ffmpeg_service import FFmpegService
    from services.transcribe import TranscribeService
    # A unique directory prevents overwriting earlier analysis or user assets.
    args.output.mkdir(parents=True, exist_ok=False)
    source = args.source.resolve(strict=True)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    media = args.output / ('source' + source.suffix.lower())
    shutil.copy2(source, media)
    metadata = {'source': str(source), 'sha256': digest,
                'media': str(media.resolve()), 'info': FFmpegService.get_media_info(str(media))}
    (args.output / 'source.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    audio = args.output / 'analysis.wav'
    FFmpegService.extract_audio(str(media), str(audio))
    svc = TranscribeService(device=args.device, compute_type='int8' if args.device == 'cpu' else 'float16')
    result = svc.transcribe(str(audio), on_progress=lambda current, total:
                           print(f'progress {current:.1f}/{total:.1f}', flush=True))
    assert hashlib.sha256(source.read_bytes()).hexdigest() == digest
    (args.output / 'transcript.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Transcription saved.', flush=True)


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    main()
