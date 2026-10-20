"""Offline CLI process tests. The fake ego executable never opens a browser."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CLI = Path(__file__).resolve().with_name('teams-native')


class NativeCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='teams-native-cli-test-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.state = root / 'state'
        self.marker = root / 'ego-called.txt'
        binary_dir = root / 'bin'
        binary_dir.mkdir()
        fake = binary_dir / 'ego-browser'
        fake.write_text(f'#!{sys.executable}\n' + '''
import json
import os
from pathlib import Path
import sys

Path(os.environ['FAKE_EGO_MARKER']).write_text(sys.stdin.read())
if os.environ['FAKE_EGO_MODE'] == 'malformed':
    print('TEAMS_NATIVE_RESULT {invalid json', file=sys.stderr)
elif os.environ['FAKE_EGO_MODE'] == 'non-object':
    print('TEAMS_NATIVE_RESULT []', file=sys.stderr)
else:
    print('runner diagnostic', file=sys.stdout)
    print('TEAMS_NATIVE_RESULT ' + json.dumps({
        'status':'PASS', 'spaceId':42,
        'account':{'id':'user-1', 'tenantId':'tenant-1', 'name':'Test User'}
    }), file=sys.stderr)
''', encoding='utf-8')
        fake.chmod(0o700)
        self.env = {**os.environ, 'PATH':str(binary_dir) + os.pathsep + os.environ.get('PATH', ''),
                    'TEAMS_NATIVE_STATE_DIR':str(self.state),
                    'FAKE_EGO_MARKER':str(self.marker), 'FAKE_EGO_MODE':'valid'}

    def configure_session(self):
        self.state.mkdir(mode=0o700)
        (self.state / 'session.json').write_text(json.dumps({
            'spaceId':42, 'account':{'id':'user-1', 'tenantId':'tenant-1'}
        }), encoding='utf-8')

    def invoke(self, *args):
        process = subprocess.run([sys.executable, str(CLI), *args], env=self.env,
                                 text=True, capture_output=True, timeout=10)
        self.assertEqual(process.stderr, '')
        return process, json.loads(process.stdout)

    def test_malformed_result_after_execute_is_unknown_without_retry(self):
        self.configure_session()
        self.env['FAKE_EGO_MODE'] = 'malformed'
        process, result = self.invoke('send', '--chat-id', '19:mock', '--text', 'hello', '--execute')
        self.assertEqual(process.returncode, 1)
        self.assertEqual(result['status'], 'SEND_OUTCOME_UNKNOWN')
        self.assertIs(result['retry'], False)
        self.assertRegex(result['clientMessageId'], r'^\d+$')
        self.assertTrue(self.marker.exists())
        receipt = json.loads((self.state / 'last-send.json').read_text())
        self.assertEqual(receipt['status'], 'SEND_OUTCOME_UNKNOWN')
        self.assertEqual(receipt['clientMessageId'], result['clientMessageId'])

    def test_valid_result_on_stderr_connects_and_persists_session(self):
        process, result = self.invoke('connect')
        self.assertEqual(process.returncode, 0)
        self.assertEqual(result['status'], 'PASS')
        session = json.loads((self.state / 'session.json').read_text())
        self.assertEqual(session['spaceId'], 42)
        self.assertEqual(session['account']['id'], 'user-1')
        self.assertTrue(self.marker.exists())

    def test_non_object_json_after_execute_is_unknown_without_retry(self):
        self.configure_session()
        self.env['FAKE_EGO_MODE'] = 'non-object'
        process, result = self.invoke('send', '--chat-id', '19:mock', '--text', 'hello', '--execute')
        self.assertEqual(process.returncode, 1)
        self.assertEqual(result['status'], 'SEND_OUTCOME_UNKNOWN')
        self.assertIs(result['retry'], False)
        self.assertRegex(result['clientMessageId'], r'^\d+$')
        self.assertTrue(self.marker.exists())
        receipt = json.loads((self.state / 'last-send.json').read_text())
        self.assertEqual(receipt['status'], 'SEND_OUTCOME_UNKNOWN')
        self.assertEqual(receipt['clientMessageId'], result['clientMessageId'])

    def test_missing_session_fails_before_browser_invocation(self):
        process, result = self.invoke('status')
        self.assertEqual(process.returncode, 1)
        self.assertEqual(result, {'status':'BLOCKED', 'error':'RUN_CONNECT_FIRST'})
        self.assertFalse(self.marker.exists())

    def test_repeatable_links_reach_runner_as_ordered_label_url_pairs(self):
        self.configure_session()
        links = [['문서 & 안내', 'https://example.test/docs?a=1&b=2'],
                 ['API [v2]', 'https://example.test/api#v2']]
        process, result = self.invoke('send', '--chat-id', '19:mock',
                                      '--text', '문서 & 안내 및 API [v2]', '--dry-run',
                                      '--link', *links[0], '--link', *links[1])
        self.assertEqual(process.returncode, 0)
        self.assertEqual(result['status'], 'PASS')
        source = self.marker.read_text(encoding='utf-8')
        args = json.loads(source.split('JSON.stringify(await run(', 1)[1].split(')));', 1)[0])
        self.assertEqual(args['links'], links)
        self.assertEqual(args['text'], '문서 & 안내 및 API [v2]')
        self.assertFalse(args['execute'])


if __name__ == '__main__':
    unittest.main()
