import unittest
from unittest.mock import AsyncMock, patch

from aira import warmup


class WarmupTests(unittest.IsolatedAsyncioTestCase):
    async def test_dns_warmup_tracks_success_and_failure(self):
        async def resolve(host):
            return host != "discordapp.com"
        with patch.object(warmup, "DNS_HOSTS", ["discord.com", "discordapp.com"]), \
             patch.object(warmup, "HTTP_URLS", []), \
             patch.object(warmup, "DNS_BUDGET_SECONDS", 0.05), \
             patch.object(warmup, "_resolve", side_effect=resolve):
            result = await warmup.warm_network()
        self.assertIn("discord.com", result["dns_ready"])
        self.assertIn("discordapp.com", result["dns_failed"])

    async def test_http_response_is_considered_warm_even_when_forbidden(self):
        class Response:
            status = 403
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
            @property
            def content(self): return self
            async def read(self, amount): return b"forbidden"
        class Session:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
            def get(self, *args, **kwargs): return Response()
        with patch.object(warmup, "DNS_HOSTS", []), \
             patch.object(warmup, "HTTP_URLS", ["https://discord.com/api/v10/gateway"]), \
             patch.object(warmup.aiohttp, "ClientSession", return_value=Session()):
            result = await warmup.warm_network()
        self.assertEqual(result["http_ready"], ["discord.com"])


if __name__ == "__main__":
    unittest.main()
