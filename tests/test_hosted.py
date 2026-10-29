import base64
import socket
import unittest
from unittest.mock import patch

import app


def basic(username, password):
    token = base64.b64encode(f'{username}:{password}'.encode()).decode()
    return {'Authorization': 'Basic ' + token}


class HostedTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        app.JOBS.clear()

    def test_render_requires_strong_password(self):
        with patch.dict(app.os.environ, {'RENDER': 'true', 'CLIPWELL_PASSWORD': ''}):
            self.assertEqual(self.client.get('/').status_code, 503)
        with patch.dict(app.os.environ, {'RENDER': 'true', 'CLIPWELL_PASSWORD': 'short'}):
            self.assertEqual(self.client.get('/').status_code, 503)

    def test_password_protects_pages_and_jobs(self):
        password = 'a-strong-password-1234'
        with patch.dict(app.os.environ, {'RENDER': 'true', 'CLIPWELL_PASSWORD': password}):
            for path in ('/', '/style.css', '/api/jobs/abc', '/api/jobs/abc/download'):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 401)
                self.assertIn('Basic', response.headers['WWW-Authenticate'])
            self.assertEqual(self.client.get('/', headers=basic('wrong', password)).status_code, 401)
            self.assertEqual(self.client.get('/', headers=basic('clipwell', 'wrong')).status_code, 401)
            response = self.client.get('/', headers=basic('clipwell', password))
            self.assertEqual(response.status_code, 200)
            response.close()

    def test_only_one_active_job_and_delete(self):
        address = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))]
        with patch.object(app.socket, 'getaddrinfo', return_value=address), patch.object(app.threading.Thread, 'start'):
            first = self.client.post('/api/jobs', json={'url': 'https://example.com/video'})
            second = self.client.post('/api/jobs', json={'url': 'https://example.com/video'})
            self.assertEqual(first.status_code, 202)
            self.assertEqual(second.status_code, 409)
            job_id = first.json['id']
            self.assertEqual(self.client.delete('/api/jobs/' + job_id).status_code, 409)
            app.JOBS[job_id]['stage'] = 'error'
            self.assertEqual(self.client.delete('/api/jobs/' + job_id).status_code, 204)
            self.assertEqual(self.client.get('/api/jobs/' + job_id).status_code, 404)


if __name__ == '__main__': unittest.main()
