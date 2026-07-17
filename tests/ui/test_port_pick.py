"""Port selection for `betterai ui`: bind-once, loud on explicit conflicts."""

from __future__ import annotations

import socket

import pytest

from app.errors import ConfigInvalidError
from app.ui.server import PREFERRED_UI_PORT, bind_ui_socket


def _hold(port: int = 0) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", port))
    sock.listen(1)
    return sock


def test_default_prefers_7788_or_falls_back_to_free_port():
    # act
    sock = bind_ui_socket(None)

    # assert: whichever branch ran, we hold a bound loopback port
    host, port = sock.getsockname()
    sock.close()
    assert host == "127.0.0.1"
    assert port == PREFERRED_UI_PORT or port > 0


def test_busy_preferred_port_falls_back_to_os_assigned():
    # arrange: occupy 7788 (skip if some other process already has it —
    # then bind_ui_socket exercises the same fallback anyway)
    try:
        holder = _hold(PREFERRED_UI_PORT)
    except OSError:
        holder = None

    # act
    sock = bind_ui_socket(None)
    port = sock.getsockname()[1]

    # assert
    sock.close()
    if holder is not None:
        holder.close()
    assert port != PREFERRED_UI_PORT
    assert port > 0


def test_explicit_busy_port_fails_loud_with_bai_121():
    # arrange
    holder = _hold(0)
    busy_port = holder.getsockname()[1]

    # act / assert
    with pytest.raises(ConfigInvalidError, match="--port"):
        bind_ui_socket(busy_port)
    holder.close()


def test_explicit_free_port_binds_exactly():
    # arrange: find a free port, release it, then bind it explicitly
    probe = _hold(0)
    free_port = probe.getsockname()[1]
    probe.close()

    # act
    sock = bind_ui_socket(free_port)

    # assert
    assert sock.getsockname()[1] == free_port
    sock.close()
