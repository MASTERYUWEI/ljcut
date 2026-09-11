"""Generate an 8-second, 30 fps test video without using personal source media."""
import argparse
import subprocess
from pathlib import Path


def create_fixture(path):
    path = Path(path)
    if path.exists():
        raise FileExistsError(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-n', '-f', 'lavfi', '-i',
        'color=c=red:s=640x360:r=30:d=8', '-f', 'lavfi', '-i',
        "aevalsrc=0.5*sin(2*PI*(440+220*floor(t/2))*t)*lt(mod(t\\,1)\\,0.2):s=48000:d=8",
        '-vf', "drawbox=color=green:t=fill:enable='gte(t,2)',drawbox=color=blue:t=fill:enable='gte(t,4)',drawbox=color=yellow:t=fill:enable='gte(t,6)'",
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', '8', str(path)],
        check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return path


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('path')
    create_fixture(parser.parse_args().path)
