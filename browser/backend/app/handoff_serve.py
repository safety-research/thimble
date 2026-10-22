"""The server of a ticket's box (ticket_box.Preview): uvicorn serving the connections the host accepts and passes over
stdin, a Unix socket, one byte with one descriptor each, so the process in the sandbox opens no port. It exits once the
host closes its end.

    python -m app.handoff_serve [module:app]
"""
from __future__ import annotations

import asyncio
import socket
import sys

import uvicorn
from uvicorn.config import STARTUP_FAILURE


class HandoffServer(uvicorn.Server):
    def __init__(self, config: uvicorn.Config, ctl: socket.socket) -> None:
        super().__init__(config)
        self.ctl = ctl
        self._tasks: set[asyncio.Task] = set()

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await self.lifespan.startup()
        if self.lifespan.should_exit:
            sys.exit(STARTUP_FAILURE)
        loop = asyncio.get_running_loop()
        config = self.config

        def protocol() -> asyncio.Protocol:
            return config.http_protocol_class(config=config, server_state=self.server_state,  # type: ignore[call-arg]
                                              app_state=self.lifespan.state, _loop=loop)

        self.servers = []
        self.ctl.setblocking(False)
        loop.add_reader(self.ctl.fileno(), self._take, loop, protocol)
        self.started = True

    def _take(self, loop: asyncio.AbstractEventLoop, protocol) -> None:
        while True:
            try:
                msg, fds, _flags, _addr = socket.recv_fds(self.ctl, 1, 4)
            except (BlockingIOError, InterruptedError):
                return
            except OSError:
                msg, fds = b"", []
            if not msg:
                loop.remove_reader(self.ctl.fileno())
                self.should_exit = True
                return
            for fd in fds:
                # family and type given, so Python asks the socket nothing; proto 0 keeps asyncio from setting options
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM, 0, fd)
                task = loop.create_task(loop.connect_accepted_socket(protocol, sock))
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)


def main(argv: list[str]) -> None:
    app = argv[1] if len(argv) > 1 else "app.main:app"
    ctl = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM, 0, 0)
    HandoffServer(uvicorn.Config(app, loop="asyncio", timeout_graceful_shutdown=3), ctl).run()  # cli.SERVER_LOOP


if __name__ == "__main__":
    main(sys.argv)
