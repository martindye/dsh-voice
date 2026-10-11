import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("voice_server", Path(__file__).parents[1] / "tts" / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class ServerTests(unittest.TestCase):
    def registry(self, failing=()):
        calls = []

        def load(name):
            calls.append((name, "load"))
            if name in failing:
                raise RuntimeError("test load failure")

        def synthesize(name, text, voice):
            calls.append((name, "synthesize"))
            return SimpleNamespace(size=0), 24000

        engines = {
            name: SimpleNamespace(name=name, load=lambda n=name: load(n),
                                  synthesize=lambda text, voice, n=name: synthesize(n, text, voice))
            for name in ("qwen3ggufbase", "pocket")
        }
        return calls, SimpleNamespace(get=engines.get, engines=lambda: list(engines.values()))

    def warm(self, selected=None):
        calls, registry = self.registry()
        env = {} if selected is None else {"VOICE_CHAT_PRELOAD_ENGINE": selected}
        with patch.dict(os.environ, env, clear=True), patch.dict(sys.modules, {"engines": registry}):
            with self.assertLogs(server.log, level="INFO"):
                server._preload()
        return calls

    def test_cpu_warmup_never_loads_gpu(self):
        self.assertEqual(self.warm("pocket"), [("pocket", "load"), ("pocket", "synthesize")])

    def test_gpu_warmup_remains_available(self):
        self.assertEqual(self.warm("qwen3ggufbase"), [("qwen3ggufbase", "load"), ("qwen3ggufbase", "synthesize")])

    def test_old_host_and_standalone_default_to_cpu_warmup(self):
        self.assertEqual(self.warm(), [("pocket", "load"), ("pocket", "synthesize")])

    def test_unknown_warmup_loads_nothing(self):
        self.assertEqual(self.warm("missing"), [])

    def render(self, selected, failing=()):
        calls, registry = self.registry(failing)
        body = json.dumps({"text": "Test", "engine": selected}).encode()
        handler = server.Handler.__new__(server.Handler)
        handler.path = "/tts"
        handler.headers = {"Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        responses = []
        handler._json = lambda code, obj: responses.append(code)
        handler._send = lambda code, body, content_type: responses.append(code)
        with patch.dict(sys.modules, {"engines": registry}), patch.object(server, "_wav", return_value=b"fake-wav"):
            handler.do_POST()
        return calls, responses

    def test_cpu_request_never_loads_gpu(self):
        calls, responses = self.render("pocket")
        self.assertEqual(calls, [("pocket", "load"), ("pocket", "synthesize")])
        self.assertEqual(responses, [200])

    def test_failed_cpu_request_does_not_fall_back_to_gpu(self):
        calls, responses = self.render("pocket", ("pocket",))
        self.assertEqual(calls, [("pocket", "load")])
        self.assertEqual(responses, [500])

    def test_failed_gpu_request_still_falls_back_to_cpu(self):
        calls, responses = self.render("qwen3ggufbase", ("qwen3ggufbase",))
        self.assertEqual(calls, [("qwen3ggufbase", "load"), ("pocket", "load"), ("pocket", "synthesize")])
        self.assertEqual(responses, [200])


if __name__ == "__main__":
    unittest.main()
