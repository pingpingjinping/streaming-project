"""Exercise deployment ordering/failure recovery without touching a Docker host."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps({'args':args,'image':os.environ.get('ANIME_IMAGE')})+'\n')
scenario = os.environ.get('SCENARIO','ok')
if args[:1] == ['info']:
    print('x86_64' if scenario == 'wrong-host' else 'aarch64')
elif args == ['compose','up','--help']:
    print('--wait-timeout')
elif args[:1] == ['compose']:
    if 'config' in args:
        sys.exit(1 if scenario == 'bad-config' else 0)
    if 'ps' in args:
        print('existing-app')
    if 'up' in args:
        if os.environ.get('ANIME_IMAGE') == 'sha256:new' and scenario == 'unhealthy':
            sys.exit(1)
elif args[:1] == ['inspect']:
    print('sha256:old')
elif args[:1] == ['pull']:
    sys.exit(1 if scenario == 'pull-fails' else 0)
elif args[:2] == ['image','inspect']:
    if args[3] == '{{.Os}}/{{.Architecture}}':
        print('linux/amd64' if scenario == 'wrong-image' else 'linux/arm64')
    else:
        print('sha256:old' if scenario == 'same-image' else 'sha256:new')
elif args[:2] == ['image','ls']:
    assert '--no-trunc' in args
    print('\\n'.join([
        'ghcr.io/pingpingjinping/streaming-project:sha-current sha256:new',
        'ghcr.io/pingpingjinping/streaming-project:sha-previous sha256:old',
        'streaming-project-rollback:old sha256:old',
        'ghcr.io/pingpingjinping/streaming-project:sha-old-old sha256:old-old',
        'streaming-project-rollback:old-old sha256:old-old',
        'streaming-project-anime:latest sha256:locally-built',
        'streaming-project-anime:before-physical-subtitles-20261016 sha256:ancient',
        'ghcr.io/pingpingjinping/violet-web:main-arm64 sha256:violet',
        'walnutpi-dashboard:latest sha256:dashboard',
    ]))
elif args[:2] == ['image','rm']:
    if scenario == 'rm-fails':
        sys.exit(1)
elif args[:1] == ['tag']:
    pass
else:
    raise RuntimeError(args)
'''


class PiDeployTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        shutil.copy(ROOT / 'scripts/deploy-pi-image.sh', self.root / 'scripts')
        for name in ['docker-compose.yml', 'docker-compose.image.yml']:
            shutil.copy(ROOT / name, self.root / name)
        (self.root / 'docker-compose.override.yml').write_text('services: {}\n')
        (self.root / 'docker').write_text(FAKE_DOCKER)
        (self.root / 'docker').chmod(0o755)
        self.log = self.root / 'calls.jsonl'

    def run_deploy(self, scenario='ok', arg=None, extra=None):
        env = {**os.environ, 'PATH': f'{self.root}:{os.environ["PATH"]}',
               'CALL_LOG': str(self.log), 'SCENARIO': scenario}
        for name in ['COMPOSE_FILE', 'COMPOSE_PATH_SEPARATOR', 'ANIME_IMAGE']:
            env.pop(name, None)
        env.update(extra or {})
        return subprocess.run(['bash', str(self.root / 'scripts/deploy-pi-image.sh'),
                               *([arg] if arg else [])], env=env, capture_output=True, text=True)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def updates(self):
        return [c for c in self.calls() if 'up' in c['args'] and '--help' not in c['args']]

    def obsolete_removals(self):
        return [c for c in self.calls() if c['args'][:2] == ['image', 'rm']]

    def test_download_before_replace_and_keep_local_override(self):
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        pull = next(i for i,c in enumerate(calls) if c['args'][0] == 'pull')
        tag = next(i for i,c in enumerate(calls) if c['args'][0] == 'tag')
        update = self.updates()[0]
        self.assertLess(pull, tag)
        self.assertLess(tag, calls.index(update))
        self.assertEqual(update['image'], 'sha256:new')
        self.assertEqual(update['args'][1:7], ['-f','docker-compose.yml',
            '-f','docker-compose.override.yml','-f','docker-compose.image.yml'])
        for flag in ['--no-build', '--no-deps', '--wait', '--wait-timeout']:
            self.assertIn(flag, update['args'])
        self.assertEqual(update['args'][-1], 'anime')
        self.assertEqual((self.root / '.pi-image/previous').read_text().strip(),
                         'streaming-project-rollback:old')
        removed = [c['args'][-1] for c in self.obsolete_removals()]
        self.assertCountEqual(removed, [
            'ghcr.io/pingpingjinping/streaming-project:sha-old-old',
            'streaming-project-rollback:old-old',
            'streaming-project-anime:latest',
            'streaming-project-anime:before-physical-subtitles-20261016',
        ])
        self.assertTrue(all(c['args'][-1].startswith(
            ('ghcr.io/pingpingjinping/streaming-project:',
             'streaming-project-rollback:', 'streaming-project-anime:')
        ) for c in self.obsolete_removals()))
        self.assertTrue(all(c['args'][-1] not in (
            'ghcr.io/pingpingjinping/streaming-project:sha-current',
            'ghcr.io/pingpingjinping/streaming-project:sha-previous',
            'streaming-project-rollback:old',
        ) for c in self.obsolete_removals()))
        self.assertLess(calls.index(update), calls.index(self.obsolete_removals()[0]))

    def test_failed_preflight_never_replaces_app(self):
        for scenario in ['wrong-host', 'bad-config', 'pull-fails', 'wrong-image']:
            with self.subTest(scenario=scenario):
                self.log.write_text('')
                self.assertNotEqual(self.run_deploy(scenario).returncode, 0)
                self.assertEqual(self.updates(), [])
                self.assertFalse((self.root / '.pi-image/previous').exists())

    def test_health_failure_restores_actual_previous_image(self):
        result = self.run_deploy('unhealthy')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([c['image'] for c in self.updates()], ['sha256:new','sha256:old'])
        self.assertFalse((self.root / '.pi-image/current').exists())

    def test_failed_deployment_does_not_prune_any_old_images(self):
        result = self.run_deploy('unhealthy')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.obsolete_removals(), [])
        self.assertFalse(any(c['args'][:2] == ['image', 'ls'] for c in self.calls()))

    def test_image_cleanup_failure_does_not_roll_back_healthy_container(self):
        result = self.run_deploy('rm-fails')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Warning: could not remove unused streaming image tag', result.stderr)
        self.assertEqual(len(self.updates()), 1)
        self.assertEqual(len(self.obsolete_removals()), 4)
        self.assertEqual((self.root / '.pi-image/current').read_text().strip(), 'sha256:new')

    def test_explicit_rollback_uses_local_image_without_pull(self):
        state = self.root / '.pi-image'
        state.mkdir()
        (state / 'previous').write_text('streaming-project-rollback:known-good\n')
        result = self.run_deploy(arg='--rollback')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(c['args'][0] == 'pull' for c in self.calls()))
        self.assertEqual(len(self.updates()), 1)

    def test_same_image_keeps_rollback_state(self):
        state = self.root / '.pi-image'
        state.mkdir()
        (state / 'previous').write_text('streaming-project-rollback:known-good\n')
        self.assertEqual(self.run_deploy('same-image').returncode, 0)
        self.assertEqual(self.updates(), [])
        self.assertEqual((state / 'previous').read_text(), 'streaming-project-rollback:known-good\n')

    def test_custom_compose_files_remain_in_order(self):
        (self.root / 'custom.yml').write_text('services: {}\n')
        result = self.run_deploy(extra={'COMPOSE_FILE': 'docker-compose.yml:custom.yml'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.updates()[0]['args'][1:7], ['-f','docker-compose.yml',
            '-f','custom.yml','-f','docker-compose.image.yml'])


@unittest.skipUnless(shutil.which('docker'), 'Docker Compose is verified on the CI runner')
class ComposeMergeTest(unittest.TestCase):
    def test_real_compose_preserves_pi_settings_and_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['docker-compose.yml', 'docker-compose.image.yml']:
                shutil.copy(ROOT / name, root / name)
            (root / '.env').write_text('POSTGRES_PASSWORD=test-only\nAUTH_SECRET=test-only\n')
            (root / 'docker-compose.override.yml').write_text(
                'services:\n  anime:\n    environment:\n      PI_SETTING: preserved\n'
                '    volumes:\n      - ./extra:/app/extra:ro\n')
            env = {**os.environ, 'ANIME_IMAGE': 'example/arm64:test'}
            result = subprocess.run(['docker', 'compose', '-f', 'docker-compose.yml',
                '-f', 'docker-compose.override.yml', '-f', 'docker-compose.image.yml',
                'config', '--format', 'json'], cwd=root, env=env,
                capture_output=True, text=True, check=True)
            config = json.loads(result.stdout)
            anime = config['services']['anime']
            self.assertEqual(anime['image'], 'example/arm64:test')
            self.assertEqual(anime['platform'], 'linux/arm64')
            self.assertEqual(anime['pull_policy'], 'never')
            self.assertEqual(anime['environment']['PI_SETTING'], 'preserved')
            self.assertEqual(anime['environment']['AUTH_SECRET'], 'test-only')
            self.assertEqual({v['target'] for v in anime['volumes']},
                {'/app/data/subtitles', '/app/data/work-audit', '/app/extra'})
            self.assertEqual(config['services']['db']['volumes'][0]['type'], 'volume')
            self.assertIn('caddy', config['services'])


if __name__ == '__main__':
    unittest.main()
