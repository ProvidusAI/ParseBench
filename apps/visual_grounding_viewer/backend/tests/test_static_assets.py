from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from app import app

Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]


async def _request(method: str, path: str) -> list[Message]:
    messages: list[Message] = []

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: Message) -> None:
        messages.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("utf-8"),
        "query_string": b"",
        "headers": [(b"host", b"testserver")],
        "client": ("testclient", 123),
        "server": ("testserver", 80),
    }
    await app(scope, receive, send)
    return messages


def _response_start(messages: list[Message]) -> Message:
    return next(message for message in messages if message["type"] == "http.response.start")


def _response_headers(messages: list[Message]) -> dict[str, str]:
    start = _response_start(messages)
    return {key.decode("latin-1"): value.decode("latin-1") for key, value in start["headers"]}


def test_static_favicon_supports_get_and_head() -> None:
    get_messages = asyncio.run(_request("GET", "/static/llamaindex-favicon.ico"))
    get_body = b"".join(message.get("body", b"") for message in get_messages if message["type"] == "http.response.body")

    assert _response_start(get_messages)["status"] == 200
    assert _response_headers(get_messages)["content-type"] == "image/x-icon"
    assert get_body.startswith(b"\x00\x00\x01\x00")

    head_messages = asyncio.run(_request("HEAD", "/static/llamaindex-favicon.ico"))
    assert _response_start(head_messages)["status"] == 200
    assert _response_headers(head_messages)["content-type"] == "image/x-icon"
