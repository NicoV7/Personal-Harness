"""InMemorySessionStore: reads never materialize state; the LRU bound holds."""

from __future__ import annotations

from app.hooks.state import InMemorySessionStore


def test_reads_never_create_sessions():
    # arrange
    store = InMemorySessionStore()

    # act: every read-shaped call on an unknown session
    value = store.get("ghost", "read_gate", "required")
    namespace = store.namespace("ghost", "read_gate")
    store.begin_turn("ghost", ("read_gate",))
    store.delete("ghost", "read_gate", "required")

    # assert
    assert value is None
    assert namespace == {}
    assert store.session_count() == 0


def test_set_and_get_roundtrip():
    # arrange
    store = InMemorySessionStore()

    # act
    store.set("s1", "ns", "k", [1, 2])

    # assert
    assert store.get("s1", "ns", "k") == [1, 2]
    assert store.namespace("s1", "ns") == {"k": [1, 2]}
    assert store.session_count() == 1


def test_begin_turn_clears_only_named_namespaces():
    # arrange
    store = InMemorySessionStore()
    store.set("s1", "turn", "k", True)
    store.set("s1", "sticky", "k", True)

    # act
    store.begin_turn("s1", ("turn",))

    # assert
    assert store.get("s1", "turn", "k") is None
    assert store.get("s1", "sticky", "k") is True


def test_clear_session_removes_everything():
    # arrange
    store = InMemorySessionStore()
    store.set("s1", "ns", "k", 1)

    # act
    store.clear_session("s1")

    # assert
    assert store.session_count() == 0
    assert store.get("s1", "ns", "k") is None


def test_eviction_drops_least_recently_active_session():
    # arrange
    store = InMemorySessionStore(max_sessions=2)
    store.set("a", "ns", "k", 1)
    store.set("b", "ns", "k", 2)

    # act: touching "a" makes "b" the eviction candidate for "c"
    store.begin_turn("a", ())
    store.set("c", "ns", "k", 3)

    # assert
    assert store.session_count() == 2
    assert store.get("b", "ns", "k") is None
    assert store.get("a", "ns", "k") == 1
    assert store.get("c", "ns", "k") == 3
