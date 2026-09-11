"""Run the agreed first-stage flow against a running LJ Cut test session.

Only uses generated fixture media. Saves to a fresh bundle and never overwrites.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path
from ljcut import Client


def main(workspace):
    workspace = Path(workspace).resolve()
    client = Client(workspace)
    report = {}
    def command(name, args=None):
        response = client.command(name, args)
        if response['status'] != 'completed':
            raise RuntimeError(response)
        return response['result']
    def version(state):
        return {'sessionId':state['sessionId'],'projectId':state['projectId'],'expectedRevision':state['revision']}
    initial=command('state')
    assert not initial['timelineClips'], 'Use an empty test editor, not an existing user project'
    fixture=workspace/'fixture.mp4'
    before_hash=hashlib.sha256(fixture.read_bytes()).hexdigest()
    imported=command('import',{**version(initial),'path':'fixture.mp4'})
    state=imported['state']
    plan={**version(state),'timeUnit':'seconds','operations':[
        {'type':'add_subtitle','clipId':imported['clipId'],'trackId':'video-main','timeDomain':'source',
         'start':4.5,'end':5.5,'text':'保留操作畫面'},
        {'type':'ripple_delete','clipId':imported['clipId'],'trackId':'video-main','timeDomain':'source',
         'start':2,'end':4,'review':'confirmed','reason':'人工指定測試區間，非沉默自動刪除'}]}
    (workspace/'plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2),encoding='utf-8')
    dry=command('dry_run',plan)
    assert command('state') == state, 'dry-run mutated editor'
    report['dryRun']=dry
    invalid=json.loads(json.dumps(plan)); invalid['operations'][1]['end']=100
    bad=client.command('dry_run',invalid)
    assert bad['error']['code']=='INVALID_RANGE',bad
    report['invalidRange']=bad['error']
    applied=command('apply',{**version(state),'dryRunId':dry['dryRunId'],'confirmed':True})['state']
    assert applied['timelineDuration']==6
    stale=client.command('apply',{**version(state),'dryRunId':dry['dryRunId'],'confirmed':True})
    assert stale['error']['code']=='STALE_PROJECT'
    report['stale']=stale['error']
    undone=command('undo',version(applied)); assert undone['timelineClips']==state['timelineClips']
    redone=command('redo',version(undone)); assert redone['timelineClips']==applied['timelineClips']
    report['batchUndoRedo']='passed'
    report['previewBeforeSave']=command('preview',{**version(redone),'time':3})
    save_name='驗收-'+time.strftime('%Y%m%d-%H%M%S')+'.ljcut'
    report['save']=command('save',{**version(redone),'path':save_name})
    reopened=command('open',{**version(redone),'path':save_name})
    assert reopened['timelineClips']==redone['timelineClips']
    assert reopened['subtitleStyle']==redone['subtitleStyle']
    report['previewAfterOpen']=command('preview',{**version(reopened),'time':3})
    assert report['previewAfterOpen']['actual']['subtitle']=='保留操作畫面'
    job=command('export',version(reopened))
    deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        job=client.request('/jobs/'+job['id'])
        if job['status'] in {'completed','failed','cancelled'}: break
        time.sleep(.2)
    assert job['status']=='completed',job
    report['export']=job
    report['sourceUnchanged']=hashlib.sha256(fixture.read_bytes()).hexdigest()==before_hash
    assert report['sourceUnchanged']
    report['sourceSHA256']=before_hash
    (workspace/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'passed':True,'report':str(workspace/'verification.json'),'video':job['outputPath'],
                      'project':report['save']['path']},ensure_ascii=False))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--workspace',required=True)
    main(parser.parse_args().workspace)
