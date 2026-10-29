import copy
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import production_handoff as H
from services.publication import mapped_captions


class Client:
    def __init__(self):
        self.state = dict(sessionId='session', projectId='project', revision=4, timelineDuration=20,
            mediaItems=[dict(id='media', filename='教學.mp4')], timelineClips=[
                dict(id='intro', mediaId='media', bookend='intro', startTime=0, trimStart=0,
                     trimEnd=15, speed=1, segments=[]),
                dict(id='main', mediaId='media', startTime=15, trimStart=4, trimEnd=8, speed=2,
                     segments=[dict(start=3, end=7, text='保留的字幕'), dict(start=9, end=10, text='剪掉')])])
        self.job = dict(id='job', status='running', progress=35, projectId='project', revision=4,
            publicationId='publication', outputPath='video.mp4')
        self.publication = dict(id='publication', videoPath='video.mp4', duration=20,
            mainSegments=[dict(start=15, end=16.5, text='保留的字幕')])
        self.cache = {}
        self.mutations = []

    def command(self, method, params=None, request_id=None, timeout=None):
        if request_id in self.cache:
            return self.cache[request_id]
        value = {'state': self.state, 'export': self.job, 'publication': self.publication,
            'prepare_covers': dict(id='batch'), 'complete_covers': dict(id='batch', items=list(range(6)))}[method]
        response = dict(status='completed', result=copy.deepcopy(value))
        if request_id:
            self.cache[request_id] = response
            self.mutations.append(method)
        return response

    def request(self, path):
        return copy.deepcopy(self.job)


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.folder = self.root / 'run'
        self.client = Client()
        self.paths = [f'{i}.png' for i in range(6)]
        for i, name in enumerate(self.paths):
            (self.root / name).write_bytes(f'image input fixture {i}'.encode())

    def test_mapping_matches_existing_core_for_trim_speed_and_bookends(self):
        clips = [dict(segments=c['segments'], time_offset=c['startTime'], trim_start=c['trimStart'],
            trim_end=c['trimEnd'], speed=c['speed']) for c in self.client.state['timelineClips'] if not c.get('bookend')]
        self.assertEqual(H.captions(self.client.state), mapped_captions(clips))

    def test_export_and_import_retry_reuses_job_batch_and_command_ids(self):
        a = H.start(self.client, self.folder)
        self.assertEqual(H.start(self.client, self.folder)['jobId'], a['jobId'])
        self.assertEqual(H.finish(self.client, self.root, self.folder, {}, self.paths)['status'], 'waiting_export')
        self.assertEqual(self.client.mutations, ['export'])
        self.client.job['status'] = 'completed'
        for _ in range(2):
            self.assertEqual(H.finish(self.client, self.root, self.folder, {}, self.paths)['count'], 6)
        self.assertEqual(self.client.mutations, ['export', 'prepare_covers', 'complete_covers'])
        with self.assertRaisesRegex(ValueError, 'COVER_INPUT_CHANGED'):
            H.finish(self.client, self.root, self.folder, {'title': 'changed'}, self.paths)

    def test_mismatched_export_or_caption_rejected_before_creating_batch(self):
        run = H.start(self.client, self.folder)
        for field, value in [('projectId', 'other'), ('revision', 5)]:
            job = dict(self.client.job, **{field: value})
            with self.assertRaisesRegex(ValueError, 'EXPORT_VERSION_MISMATCH'):
                H.check_export(run, job, self.client.publication)
        self.client.job['status'] = 'completed'
        self.client.publication['mainSegments'][0]['text'] = '後來改過的字幕'
        with self.assertRaisesRegex(ValueError, 'TRANSCRIPT_CHANGED'):
            H.finish(self.client, self.root, self.folder, {}, self.paths)
        self.assertEqual(self.client.mutations, ['export'])

    def test_rejects_failed_export_and_workspace_escape(self):
        H.start(self.client, self.folder)
        self.client.job['status'] = 'failed'
        with self.assertRaisesRegex(ValueError, 'EXPORT_NOT_COMPLETED'):
            H.finish(self.client, self.root, self.folder, {}, self.paths)
        with self.assertRaisesRegex(ValueError, 'WORKSPACE_PATH_REQUIRED'):
            H.inside(self.root, '../outside.png')


if __name__ == '__main__':
    unittest.main()
