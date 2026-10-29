"""Snapshot an approved edit, start export, then bind parallel cover work to it.

Uses the existing local client only. Does not start agents, generate images,
edit the timeline, select a cover, or upload to YouTube.
"""
import argparse
import hashlib
import json
import sys
import uuid
from pathlib import Path

from ljcut import Client


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def inside(root, name):
    path = (root / name).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError('WORKSPACE_PATH_REQUIRED: 請使用工作區內的檔案或子資料夾')
    return path


def result(client, method, params=None, request_id=None):
    response = client.command(method, params, request_id=request_id, timeout=20)
    if response['status'] != 'completed':
        raise RuntimeError(json.dumps(response, ensure_ascii=False))
    return response['result']


def captions(state):
    cues = []
    for clip in state['timelineClips']:
        if clip.get('bookend'):
            continue
        for cue in clip['segments']:
            start = max(cue['start'], clip['trimStart'])
            end = min(cue['end'], clip['trimEnd'])
            if end > start and cue['text'].strip():
                cues.append(dict(start=clip['startTime']+(start-clip['trimStart'])/clip['speed'],
                    end=clip['startTime']+(end-clip['trimStart'])/clip['speed'], text=cue['text']))
    return sorted(cues, key=lambda cue: cue['start'])


def digest(cues):
    normalized = [dict(start=round(float(c['start']), 6), end=round(float(c['end']), 6), text=c['text']) for c in cues]
    return hashlib.sha256(json.dumps(normalized, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def check_export(run, job, publication):
    if job['projectId'] != run['projectId'] or job['revision'] != run['revision']:
        raise ValueError('EXPORT_VERSION_MISMATCH: 匯出與封面依據的專案版本不同')
    if publication['id'] != job['publicationId'] or publication['videoPath'] != job['outputPath']:
        raise ValueError('EXPORT_ID_MISMATCH: 封面必須綁定本次匯出工作')
    if abs(publication['duration'] - run['duration']) > .001:
        raise ValueError('EXPORT_DURATION_MISMATCH: 成品長度已變更')
    if digest(publication['mainSegments']) != run['captionDigest']:
        raise ValueError('TRANSCRIPT_CHANGED: 字幕或剪輯已變更，請重新核對文案與封面')


def start(client, folder):
    manifest = folder / 'handoff.json'
    if manifest.exists():
        run = read(manifest)
        if run.get('jobId'):
            return run
    else:
        state = result(client, 'state')
        cues = captions(state)
        if not cues:
            raise ValueError('NO_TRANSCRIPT: 請先完成主片字幕與剪輯確認')
        folder.mkdir(parents=True, exist_ok=True)
        run = dict(id=uuid.uuid4().hex, sessionId=state['sessionId'], projectId=state['projectId'],
            revision=state['revision'], duration=state['timelineDuration'], mainSegments=cues,
            captionDigest=digest(cues), timelineClips=state['timelineClips'],
            media=[dict(id=m['id'], filename=m['filename']) for m in state['mediaItems']])
        # Persist the command identity BEFORE dispatch: retries reuse the same export.
        write(manifest, run)
    job = result(client, 'export', dict(sessionId=run['sessionId'], projectId=run['projectId'],
        expectedRevision=run['revision']), run['id']+'-export')
    run['jobId'] = job['id']
    write(manifest, run)
    return run


def finish(client, root, folder, analysis, paths):
    manifest = folder / 'handoff.json'
    run = read(manifest)
    job = client.request('/jobs/'+run['jobId'])
    if job['status'] in {'queued', 'running'}:
        return dict(status='waiting_export', progress=job['progress'], jobId=job['id'])
    if job['status'] != 'completed':
        raise ValueError('EXPORT_NOT_COMPLETED: '+json.dumps(job, ensure_ascii=False))
    pub = result(client, 'publication', dict(publicationId=job['publicationId']))
    check_export(run, job, pub)
    if len(paths) != 6:
        raise ValueError('SIX_REQUIRED: 必須提供六張圖片')
    files = [inside(root, name) for name in paths]
    payload = dict(analysis=analysis, paths=[f.relative_to(root).as_posix() for f in files])
    input_digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()
        + b''.join(hashlib.sha256(f.read_bytes()).digest() for f in files)).hexdigest()
    if run.get('coverInputDigest') not in (None, input_digest):
        raise ValueError('COVER_INPUT_CHANGED: 重試請沿用同一批文案與圖片')
    run['coverInputDigest'] = input_digest
    write(manifest, run)
    if not run.get('batchId'):
        batch = result(client, 'prepare_covers', dict(publicationId=pub['id']), run['id']+'-batch')
        run.update(batchId=batch['id'], publicationId=pub['id'])
        write(manifest, run)
    batch = result(client, 'complete_covers', dict(batchId=run['batchId'], **payload), run['id']+'-complete')
    run['status'] = 'ready'
    write(manifest, run)
    return dict(status='ready', publicationId=pub['id'], batchId=batch['id'], count=len(batch['items']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--run', required=True, help='工作區內本次專屬資料夾；同名用於重試')
    parser.add_argument('action', choices=['start', 'finish'])
    parser.add_argument('--analysis', help='工作區內的摘要／亮點／封面文案 JSON')
    parser.add_argument('--images', nargs=6, help='工作區內六張生成圖片')
    args = parser.parse_args()
    root = Path(args.workspace).resolve()
    folder = inside(root, args.run)
    if args.action == 'finish' and (not args.analysis or not args.images):
        parser.error('finish requires --analysis and --images')
    client = Client(root)
    value = start(client, folder) if args.action == 'start' else finish(client, root, folder,
        read(inside(root, args.analysis)), args.images)
    print(json.dumps({k: v for k, v in value.items() if k not in {'mainSegments', 'timelineClips'}}, ensure_ascii=False))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        main()
    except Exception as error:
        print(json.dumps(dict(status='failed', error=str(error)), ensure_ascii=False))
        sys.exit(1)
