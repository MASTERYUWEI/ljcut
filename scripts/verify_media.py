"""Measure the deterministic fixture export: frames, audio pulses and subtitle pixels.

Uses the existing backend NumPy dependency and installed FFmpeg/FFprobe.
"""
import argparse
import json
import subprocess
from pathlib import Path
import numpy as np


def run(*args):
    return subprocess.run(list(args),capture_output=True,check=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0)).stdout


def verify(workspace, video=None):
    root=Path(workspace)
    report=json.loads((root/'verification.json').read_text(encoding='utf-8'))
    video=video or report['export']['outputPath']
    probe=json.loads(run('ffprobe','-v','error','-show_streams','-show_format','-of','json',video))
    streams=probe['streams']; v=next(s for s in streams if s['codec_type']=='video'); a=next(s for s in streams if s['codec_type']=='audio')
    assert int(v['nb_frames'])==180, v
    assert abs(float(v['duration'])-6)<1/30 and abs(float(a['duration'])-6)<1/30
    assert abs(float(v['start_time'])-float(a['start_time']))<1/30
    def frame(t):
        raw=run('ffmpeg','-v','error','-ss',str(t),'-i',video,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1')
        return np.frombuffer(raw,dtype=np.uint8).reshape(360,640,3)
    expected=[(0.5,[253,0,0]),(2.05,[0,0,254]),(4.05,[253,253,0])]
    colors=[]
    for t,rgb in expected:
        actual=frame(t)[40:100,40:200].mean(axis=(0,1)); colors.append({'time':t,'rgb':actual.tolist()})
        assert np.max(np.abs(actual-np.array(rgb)))<12,(t,actual)
    before,during,after=frame(2.3),frame(3),frame(3.7)
    def white(im):
        ys,xs=np.nonzero(np.min(im,axis=2)>190)
        return len(ys), ([int(xs.min()),int(ys.min()),int(xs.max()),int(ys.max())] if len(ys) else None)
    assert white(before)[0]==0 and white(after)[0]==0
    pixels,bounds=white(during); assert pixels>100 and bounds[1]>250 and bounds[3]<360,(pixels,bounds)
    raw=run('ffmpeg','-v','error','-i',video,'-vn','-ac','1','-ar','48000','-f','f32le','pipe:1')
    audio=np.frombuffer(raw,dtype='<f4')
    assert abs(len(audio)/48000-6)<.03
    pulses=[]
    for sec in range(6):
        chunk=audio[sec*48000:(sec+1)*48000]
        envelope=np.sqrt(np.mean(chunk[:(len(chunk)//48)*48].reshape(-1,48)**2,axis=1))
        idx=np.flatnonzero(envelope>.08)
        onset=int(idx[0])/1000; end=int(idx[-1]+1)/1000
        assert onset<.02 and abs(end-.2)<.025,(sec,onset,end)
        window=chunk[2400:7200]; spec=np.abs(np.fft.rfft(window*np.hanning(len(window))))
        frequency=np.fft.rfftfreq(len(window),1/48000)[np.argmax(spec)]
        expected_freq=440 if sec<2 else 880 if sec<4 else 1100
        assert abs(frequency-expected_freq)<15,(sec,frequency)
        pulses.append({'timelineSecond':sec,'onsetSeconds':onset,'endSeconds':end,'frequencyHz':float(frequency)})
    output={'passed':True,'video':str(video),'videoFrames':int(v['nb_frames']),'videoDuration':float(v['duration']),
            'audioDuration':float(a['duration']),'frameColors':colors,'subtitleWhitePixelBounds':bounds,'audioPulses':pulses}
    (root/'media-verification.json').write_text(json.dumps(output,indent=2),encoding='utf-8')
    run('ffmpeg','-v','error','-y','-ss','3','-i',video,'-frames:v','1',str(root/'export-preview.png'))
    print(json.dumps(output,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--workspace',required=True);parser.add_argument('--video')
    args=parser.parse_args(); verify(args.workspace,args.video)
