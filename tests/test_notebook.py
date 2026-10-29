"""Keep the Colab notebook valid and free of pre-executed or personal data."""
import json
import unittest
from pathlib import Path


class NotebookTests(unittest.TestCase):
    def test_notebook_is_valid_and_unexecuted(self):
        notebook = json.loads(Path('Clipwell_Colab.ipynb').read_text(encoding='utf-8'))
        self.assertEqual(notebook['nbformat'], 4)
        code_cells = [cell for cell in notebook['cells'] if cell['cell_type'] == 'code']
        self.assertTrue(code_cells)
        for cell in code_cells:
            self.assertIsNone(cell['execution_count'])
            self.assertEqual(cell['outputs'], [])
            compile(''.join(cell['source']), 'Clipwell_Colab.ipynb', 'exec')
        source = ''.join(code_cells[0]['source'])
        self.assertIn('video_url = ""', source)
        self.assertIn('files.download(str(result_path))', source)


if __name__ == '__main__':
    unittest.main()
