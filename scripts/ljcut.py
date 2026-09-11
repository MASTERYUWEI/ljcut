"""Local LJ Cut client. Standard library only; JSON in/out, no shell commands.

python scripts/ljcut.py --workspace app_data/control state
python scripts/ljcut.py --workspace app_data/control dry_run --params plan.json
"""
import argparse
import json
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class Client:
    def __init__(self, workspace):
        self.config = json.loads((Path(workspace) / '.ljcut-control.json').read_text(encoding='utf-8'))
        from urllib.parse import urlparse
        address = urlparse(self.config['url'])
        if address.scheme != 'http' or address.hostname != '127.0.0.1':
            raise ValueError('Control address must be loopback HTTP')

    def request(self, path, data=None):
        request = Request(self.config['url'] + '/api/control' + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers={'Authorization': 'Bearer ' + self.config['token'], 'Content-Type': 'application/json'})
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as e:
            detail = json.load(e).get('detail', {})
            raise RuntimeError(json.dumps(detail, ensure_ascii=False)) from e

    def command(self, method, params=None, request_id=None, timeout=120):
        cid = request_id or uuid.uuid4().hex
        result = self.request('/commands', {'id': cid, 'method': method, 'params': params or {}})
        deadline = time.monotonic() + timeout
        while result['status'] in {'queued', 'delivered'} and time.monotonic() < deadline:
            time.sleep(.3)
            result = self.request('/commands/' + cid)
        if result['status'] in {'queued', 'delivered'}:
            return {'id': cid, 'status': result['status'], 'message': '尚未完成；以同一 request-id 查詢，勿另建 ID 重送修改'}
        return result


def main():
    parser = argparse.ArgumentParser(description='LJ Cut local control (no paid services)')
    parser.add_argument('--workspace', required=True)
    parser.add_argument('command', choices=['state', 'dry_run', 'apply', 'undo', 'redo', 'import', 'save', 'open', 'preview', 'export', 'job', 'cancel', 'result'])
    parser.add_argument('--params', help='UTF-8 JSON file; mutations require projectId and expectedRevision')
    parser.add_argument('--request-id', help='Reuse the SAME ID only with the SAME command after an uncertain response')
    parser.add_argument('--id', help='Job ID or command result ID')
    args = parser.parse_args()
    try:
        client = Client(args.workspace)
        if args.command in {'job', 'cancel', 'result'}:
            if not args.id:
                parser.error('--id is required')
            path = ('/commands/' if args.command == 'result' else '/jobs/') + args.id
            result = client.request(path + ('/cancel' if args.command == 'cancel' else ''), {} if args.command == 'cancel' else None)
        else:
            params = json.loads(Path(args.params).read_text(encoding='utf-8-sig')) if args.params else {}
            result = client.command(args.command, params, args.request_id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if result.get('status') == 'failed':
            return 1
    except Exception as e:
        print(json.dumps({'status': 'failed', 'error': str(e)}, ensure_ascii=False))
        return 1
    return 0


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
