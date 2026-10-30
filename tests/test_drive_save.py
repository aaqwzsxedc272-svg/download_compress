import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import colab_ui


class DriveSaveTests(unittest.TestCase):
    def test_mount_is_required_and_option_defaults_off(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'MyDrive').mkdir()
            source = root / 'source.mp4'
            source.write_bytes(b'video')
            self.assertFalse(colab_ui.drive_available(root))
            with self.assertRaisesRegex(RuntimeError, 'not connected'):
                colab_ui.save_to_drive(source, root)
            ui = colab_ui.ClipwellUI(lambda _: None, output_dir=root / 'out', drive_root=root)
            self.assertFalse(ui.save_drive.value)
            ui.save_drive.value = True
            ui.input_urls.value = 'https://example.com/video'
            with patch.object(app, 'run_job') as run:
                ui._start(None)
            run.assert_not_called()
            self.assertIn('not connected', ui.message.value)

    def test_opt_out_does_not_copy_to_drive(self):
        def fake_run(job_id):
            folder = app.WORK_DIR / job_id
            folder.mkdir()
            output = folder / 'compressed.mp4'
            output.write_bytes(b'output')
            app.update(job_id, stage='done', progress=100, source_size=100, output_size=6, path=str(output))
        with tempfile.TemporaryDirectory() as folder:
            ui = colab_ui.ClipwellUI(lambda _: None, output_dir=Path(folder) / 'out', drive_root=Path(folder))
            ui.input_urls.value = 'https://example.com/video'
            with patch.object(app, 'validate_url'), patch.object(app, 'run_job', side_effect=fake_run), \
                 patch.object(colab_ui.time, 'sleep'), patch.object(colab_ui, 'save_to_drive') as copy:
                ui._start(None)
            copy.assert_not_called()
            self.assertEqual(len(ui.results.children), 1)

    def test_copy_completed_file_and_clean_partial_on_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'MyDrive').mkdir()
            source = root / 'result.mp4'
            source.write_bytes(b'video bytes')
            with patch.object(colab_ui.os.path, 'ismount', return_value=True):
                result = colab_ui.save_to_drive(source, root)
                self.assertEqual(result.read_bytes(), b'video bytes')
                self.assertEqual(source.read_bytes(), b'video bytes')
                self.assertFalse(list(result.parent.glob('*.partial')))
                with self.assertRaisesRegex(RuntimeError, 'already exists'):
                    colab_ui.save_to_drive(source, root)
                other = root / 'second.mp4'
                other.write_bytes(b'bytes')
                with patch.object(colab_ui, 'copyfileobj', side_effect=OSError('quota')):
                    with self.assertRaises(OSError):
                        colab_ui.save_to_drive(other, root)
                self.assertFalse((result.parent / 'second.mp4').exists())
                self.assertFalse(list(result.parent.glob('*.partial')))

    def test_queue_copies_each_completed_video_and_preserves_local_on_failure(self):
        def fake_run(job_id):
            folder = app.WORK_DIR / job_id
            folder.mkdir()
            output = folder / 'compressed.mp4'
            output.write_bytes(b'output')
            app.update(job_id, stage='done', progress=100, source_size=200, output_size=6, path=str(output))
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'MyDrive').mkdir()
            downloads = []
            ui = colab_ui.ClipwellUI(downloads.append, output_dir=root / 'out', drive_root=root)
            ui.input_urls.value = 'https://example.com/1\nhttps://example.com/2'
            ui.save_drive.value = True
            actual = colab_ui.save_to_drive
            calls = []
            def fail_second(source, mount):
                calls.append(source)
                if len(calls) == 2:
                    raise OSError('quota')
                return actual(source, mount)
            with patch.object(colab_ui.os.path, 'ismount', return_value=True), patch.object(app, 'validate_url'), \
                 patch.object(app, 'run_job', side_effect=fake_run), patch.object(colab_ui.time, 'sleep'), \
                 patch.object(colab_ui, 'save_to_drive', side_effect=fail_second):
                ui._start(None)
            self.assertEqual(len(list((root / 'MyDrive' / 'Clipwell').glob('*.mp4'))), 1)
            self.assertIn('1 copied', ui.message.value)
            self.assertIn('1 Drive copies failed', ui.message.value)
            for item in ui.results.children:
                item.children[-1].click()
            self.assertEqual(len(downloads), 2)
            self.assertTrue(all(Path(path).exists() for path in downloads))
            self.assertIn('Could not save to Drive', ui.results.children[1].children[1].value)


if __name__ == '__main__': unittest.main()
