"""Exercise bookends through the real external mailbox in an EMPTY test editor.

Create fixture.mp4, intro.mp4 and outro.mp4 in the isolated test workspace first.
Never run against an editor holding user work. No cloud APIs are called.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path
from ljcut import Client


def main(workspace):
    root = Path(workspace).resolve()
    client = Client(root)
    def command(method, params=None):
        result = client.command(method, params)
        assert result['status'] == 'completed', result
        return result['result']
    def version(state):
        return dict(sessionId=state['sessionId'],projectId=state['projectId'],expectedRevision=state['revision'])
    state = command('state')
    assert not state['timelineClips'] and not state['mediaItems'], 'Use an empty isolated test editor'
    hashes = {name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ('fixture.mp4','intro.mp4','outro.mp4')}
    imported = command('import',{**version(state),'path':'fixture.mp4'})
    state = imported['state']
    d = command('dry_run',{**version(state),'timeUnit':'seconds','operations':[
        dict(type='add_subtitle',clipId=imported['clipId'],trackId='video-main',timeDomain='source',start=4.5,end=5.5,text='字幕跟隨主影片')]})
    state = command('apply',{**version(state),'dryRunId':d['dryRunId'],'confirmed':True})['state']
    current = command('production_settings')
    command('set_production_settings',dict(expectedSettingsRevision=current['revision'],introPath='intro.mp4',outroPath='outro.mp4',useIntro=True,useOutro=True))
    d = command('prepare_bookends',version(state))
    assert command('state') == state, 'Bookends dry-run mutated project'
    assert abs(d['afterDuration']-11)<.001
    edited = command('apply',{**version(state),'dryRunId':d['dryRunId'],'confirmed':True})['state']
    assert edited['timelineClips'][1]['id'] == imported['clipId']
    assert edited['timelineClips'][1]['segments'] == state['timelineClips'][0]['segments']
    duplicate = client.command('prepare_bookends',version(edited))
    assert duplicate['error']['code'] == 'BOOKENDS_ALREADY_PRESENT', duplicate
    stale = client.command('apply',{**version(state),'dryRunId':d['dryRunId'],'confirmed':True})
    assert stale['error']['code'] == 'STALE_PROJECT', stale
    undone = command('undo',version(edited))
    assert undone['timelineClips'] == state['timelineClips'] and undone['mediaItems'] == state['mediaItems']
    redone = command('redo',version(undone))
    assert redone['timelineClips'] == edited['timelineClips']
    preview = [command('preview',{**version(redone),'time':t}) for t in (.5,5.75,9.5)]
    assert preview[1]['actual']['subtitle'] == '字幕跟隨主影片'
    path = 'bookends-'+time.strftime('%Y%m%d-%H%M%S')+'.ljcut'
    saved = command('save',{**version(redone),'path':path})
    reopened = command('open',{**version(redone),'path':path})
    assert reopened['timelineClips'] == redone['timelineClips']
    after_open = command('preview',{**version(reopened),'time':5.75})
    assert after_open['actual']['subtitle'] == preview[1]['actual']['subtitle']
    job = command('export',version(reopened))
    deadline = time.monotonic()+90
    while time.monotonic()<deadline:
        job = client.request('/jobs/'+job['id'])
        if job['status'] not in ('queued','running'): break
        time.sleep(.2)
    assert job['status']=='completed',job
    assert '00:00:05,500 --> 00:00:06,500' in Path(job['srtPath']).read_text(encoding='utf-8')
    assert hashes == {name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in hashes}
    report = dict(passed=True,dryRun=d,preview=preview,previewAfterOpen=after_open,export=job,saved=saved,sourceHashes=hashes)
    (root/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(dict(passed=True,report=str(root/'verification.json')),ensure_ascii=False))


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--workspace',required=True)
    main(parser.parse_args().workspace)
