"""BetterAI CLI (typer). There is NO offline mode: every server-backed
verb talks to the local stack and, when it is unreachable, prints the
BAI-601 envelope (whose message says to run `betterai start`) and exits
1 -- fail loud, one attempt, no fallback (fail-loud-no-retries).

os.environ is only read here (CLI = process entrypoint, same standing as
main); installer/adapter modules receive everything explicitly.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import time
from pathlib import Path

import typer

from app.errors import BetterAIError, Errors
from app.installer.adapters import client_status, install_client, uninstall_client
from app.installer.bridge import write_bridge
from app.installer.compose import render_compose
from app.installer.hooks_scripts import write_hook_scripts
from app.installer.install_env import betterai_root, install_env_values
from app.installer.memory_provider import memory_provider_wiring
from app.mcp_client import mcp_call, server_get, server_post
from app.settings import REQUIRED_KEYS

app = typer.Typer(no_args_is_help=True, add_completion=False)

_SUBDIRS = ("audit", "hooks", "bin", "config", "models", "redis", "postgres", "rules", "skills")


def perform_install(
    user_home: str,
    *,
    clients: list[str],
    granularity: str,
    memory_provider: str,
    judge_model: str,
    openrouter_key_file: str,
    run_client_exec: bool,
    prompt_improver_model: str = "",
) -> str:
    """Write the full install tree under <user_home>/.betterai."""
    root = Path(betterai_root(user_home))
    for subdir in _SUBDIRS:
        (root / subdir).mkdir(parents=True, exist_ok=True)
    _write_token(root / "token")
    _copy_key_file(openrouter_key_file, root / "openrouter-key")
    values = install_env_values(
        user_home,
        overrides={
            "BETTERAI_OPENROUTER_AGENT_MODEL": judge_model,
            "BETTERAI_PROMPT_IMPROVER_MODEL": prompt_improver_model,
            "BETTERAI_EDIT_GRANULARITY": granularity,
            "BETTERAI_MEMORY_PROVIDER": memory_provider,
        },
    )
    _write_env(root, values)
    _write_private(root / "docker-compose.yml", render_compose(user_home, memory_provider))
    _make_memory_dirs(memory_provider, user_home)
    write_hook_scripts(user_home)
    write_bridge(user_home)
    for client in clients:
        install_client(client, user_home, run_client_exec=run_client_exec)
    return str(root)


@app.command()
def install(
    clients: str = typer.Option("claude,codex", "--clients"),
    granularity: str = typer.Option("none", "--granularity"),
    with_memory: str = typer.Option("none", "--with-memory"),
    judge_model: str = typer.Option(..., "--judge-model", prompt="OpenRouter judge model id"),
    openrouter_key_file: str = typer.Option(
        ..., "--openrouter-key-file", prompt="Path to a file containing your OpenRouter API key"
    ),
    prompt_improver_model: str = typer.Option(
        "",
        "--prompt-improver-model",
        help="OpenRouter model for prompt expansion; empty reuses the judge model, 'off' disables",
    ),
) -> None:
    """Write dirs, token, .env, compose, hooks, bridge, and client adapters."""
    root = _fail_loud(
        lambda: perform_install(
            _user_home(),
            clients=_parse_clients(clients),
            granularity=granularity,
            memory_provider=with_memory,
            judge_model=judge_model,
            openrouter_key_file=openrouter_key_file,
            run_client_exec=os.environ.get("BETTERAI_SKIP_CLIENT_EXEC") != "1",
            prompt_improver_model=prompt_improver_model,
        )
    )
    typer.echo(f"betterai install: ready at {root}")
    typer.echo("token: <root>/token (not printed); next: `betterai start`")


@app.command()
def start() -> None:
    """docker compose up -d --wait, then report /health."""
    compose_file = Path(betterai_root(_user_home())) / "docker-compose.yml"
    result = subprocess.run(
        ["docker", "compose", "-f", str(compose_file), "up", "-d", "--wait"], check=False
    )
    if result.returncode != 0:
        _print_exit(Errors.container_op_failed("docker compose up -d --wait exited non-zero"))
    typer.echo(json.dumps(_fail_loud(lambda: server_get(_user_home(), "/health"))))


@app.command()
def harness(
    action: str = typer.Argument(..., help="on|off|status"),
    clients: str = typer.Option("claude,codex", "--clients"),
) -> None:
    """Toggle client wiring; sentinel blocks make off a clean revert."""
    names = _parse_clients(clients)
    if action not in ("on", "off", "status"):
        typer.echo("betterai harness: expected on|off|status", err=True)
        raise typer.Exit(2)
    if action == "on":
        write_hook_scripts(_user_home())
        write_bridge(_user_home())
    actions = {"on": lambda c: install_client(c, _user_home()), "off": lambda c: uninstall_client(c, _user_home()), "status": lambda c: client_status(c, _user_home())}
    for name in names:
        status = actions[action](name)
        typer.echo(f"{status.client}: {'on' if status.installed else 'off'} ({status.detail}) {status.path}")


@app.command()
def doctor() -> None:
    """Diagnostic escape hatch: reports every check, exits 1 on failures."""
    root = Path(betterai_root(_user_home()))
    failures = 0
    failures += _check("docker", shutil.which("docker") is not None)
    failures += _check("compose file", (root / "docker-compose.yml").exists())
    failures += _check("token mode 0600", _is_private(root / "token"))
    failures += _check("openrouter key mode 0600", _is_private(root / "openrouter-key"))
    failures += _check("bridge executable", os.access(root / "bin" / "betterai-mcp-stdio", os.X_OK))
    failures += _check_env_fresh(root / ".env")
    failures += _check_server_health()
    for client in ("claude", "codex", "generic"):
        status = client_status(client, _user_home())
        typer.echo(f"{'ok' if status.installed else 'warn'} {client}: {'configured' if status.installed else 'not configured'}")
    raise typer.Exit(0 if failures == 0 else 1)


@app.command()
def status() -> None:
    """Server /health as JSON (includes per-service state when provided)."""
    typer.echo(json.dumps(_fail_loud(lambda: server_get(_user_home(), "/health"))))


@app.command("list")
def list_skills() -> None:
    """Inventory via the list_skills MCP tool."""
    typer.echo(json.dumps(_fail_loud(lambda: mcp_call(_user_home(), "list_skills", {}))))


@app.command()
def add(
    file: str = typer.Argument(..., help="Path to a markdown artifact (frontmatter + body)"),
    forced: bool = typer.Option(
        False, "--forced", help="Inject this artifact into every retrieval"
    ),
) -> None:
    """Add a raw markdown rule/skill via add_skill (parse -> classify -> index)."""
    path = Path(file).expanduser()
    if not path.is_file():
        _print_exit(Errors.config_invalid("file", f"no readable markdown at {file}"))
    arguments: dict = {"markdown": path.read_text(encoding="utf-8")}
    if forced:
        arguments["forced"] = True
    typer.echo(json.dumps(_fail_loud(lambda: mcp_call(_user_home(), "add_skill", arguments))))


@app.command()
def configure(
    skill_id: str = typer.Argument(..., help="Artifact id declaring settings_schema"),
    pairs: list[str] = typer.Argument(..., help="key=value settings, e.g. level=lines:2"),
) -> None:
    """Set declared settings options on a skill via configure_skill."""
    settings: dict[str, str] = {}
    for pair in pairs:
        key, separator, value = pair.partition("=")
        if not separator or not key or not value:
            _print_exit(Errors.config_invalid("settings", f"expected key=value, got {pair!r}"))
        settings[key] = value
    arguments = {"skill_id": skill_id, "settings": settings}
    typer.echo(
        json.dumps(_fail_loud(lambda: mcp_call(_user_home(), "configure_skill", arguments)))
    )


@app.command()
def why(file: str = typer.Argument(...)) -> None:
    """Which rules/skills apply to FILE, via query_skills."""
    arguments = {
        "context": {
            "intent": f"rules and skills that apply when editing {file}",
            "file_paths": [file],
        },
        "top_k": 8,
    }
    typer.echo(json.dumps(_fail_loud(lambda: mcp_call(_user_home(), "query_skills", arguments))))


@app.command()
def validate() -> None:
    """Corpus validation: server-side read via list_skills (loading the
    corpus validates every artifact's frontmatter server-side).
    TODO(P8): dedicated /validate endpoint with per-file diagnostics."""
    result = _fail_loud(lambda: mcp_call(_user_home(), "list_skills", {}))
    typer.echo(json.dumps({"validated": True, "inventory": result}))


@app.command()
def check(file: str = typer.Argument(...)) -> None:
    _not_implemented("check", "deterministic corpus checks land with the eval harness")


@app.command()
def index() -> None:
    """Re-read the corpus and rebuild the redis/pg index via POST /reindex."""
    typer.echo(json.dumps(_fail_loud(lambda: server_post(_user_home(), "/reindex", {}))))


@app.command()
def ingest(url: str = typer.Argument(..., help="Blog post URL to distill into the corpus")) -> None:
    """Parse, chunk, and distill a post into corpus rules/skills via POST /ingest."""
    result = _fail_loud(
        lambda: server_post(_user_home(), "/ingest", {"url": url}, timeout=600.0)
    )
    typer.echo(json.dumps(result))


@app.command("export-memories")
def export_memories() -> None:
    # TODO(P6): emit the selected provider's format via the seam in
    # app/installer/memory_provider.py once the exporter lands.
    _not_implemented("export-memories", "provider export (P6) not in this build")


eval_app = typer.Typer(no_args_is_help=True, help="Task evals (A/B + blind judge) and smoke.")
app.add_typer(eval_app, name="eval")

_FIXTURES_DIR_OPTION = typer.Option(
    "tests/product/evals", "--fixtures-dir", help="Directory holding fixtures/ and rubric-blogs.yaml"
)


@eval_app.command("fixtures")
def eval_fixtures(fixtures_dir: str = _FIXTURES_DIR_OPTION) -> None:
    """List fixtures with their expected rules/skills and rubric coverage."""
    from app.evals.rubric import list_fixtures

    rows = _fail_loud(lambda: list_fixtures(Path(fixtures_dir) / "fixtures"))
    summary = [
        {
            "id": fixture["id"],
            "criteria": len(fixture["rubric"]),
            "expected_rubric_min": fixture.get("expected_rubric_min"),
            "expected_rule_fires": fixture.get("expected_rule_fires", []),
            "expected_skill_reads": fixture.get("expected_skill_reads", []),
        }
        for fixture in rows
    ]
    typer.echo(json.dumps(summary, indent=2))


@eval_app.command("run")
def eval_run(
    fixture: str = typer.Option(None, "--fixture", help="Run one fixture id; omit for all"),
    fixtures_dir: str = _FIXTURES_DIR_OPTION,
) -> None:
    """Two-arm A/B per fixture with a blind LLM judge; writes report.json."""
    from app.evals.runner import run_evals

    report = _fail_loud(
        lambda: run_evals(
            user_home=_user_home(), fixtures_dir=Path(fixtures_dir), fixture_id=fixture
        )
    )
    typer.echo(json.dumps(report, indent=2))


@eval_app.command("install-smoke")
def eval_install_smoke(
    dry_run: bool = typer.Option(False, "--dry-run", help="Skip live server probes"),
) -> None:
    """Install into a throwaway HOME and verify tree, gates wiring, secrets."""
    from app.evals.smoke import run_install_smoke

    result = _fail_loud(lambda: run_install_smoke(dry_run=dry_run, user_home=_user_home()))
    typer.echo(json.dumps(result, indent=2))
    if not result["passed"]:
        raise typer.Exit(1)


def _not_implemented(verb: str, detail: str) -> None:
    typer.echo(f"betterai {verb}: not implemented in this build ({detail})", err=True)
    raise typer.Exit(1)


def _user_home() -> str:
    return os.environ.get("HOME") or str(Path.home())


def _parse_clients(raw: str) -> list[str]:
    names = [item.strip() for item in raw.split(",") if item.strip() in ("claude", "codex", "generic")]
    return names or ["claude", "codex"]


def _write_token(path: Path) -> None:
    if not path.exists() or path.stat().st_size == 0:
        path.write_text(secrets.token_hex(32) + "\n")
    path.chmod(0o600)


def _copy_key_file(source: str, target: Path) -> None:
    source_path = Path(source).expanduser()
    if not source_path.is_file() or not source_path.read_text().strip():
        raise Errors.config_invalid("--openrouter-key-file", f"no readable key at {source}")
    _write_private(target, source_path.read_text())


def _write_env(root: Path, values: dict[str, str]) -> None:
    env_path = root / ".env"
    if env_path.exists():
        shutil.copy2(env_path, root / f".env.bak.{int(time.time())}")
    _write_private(env_path, "".join(f"{key}={value}\n" for key, value in values.items()))


def _write_private(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    path.chmod(0o600)


def _make_memory_dirs(provider: str, user_home: str) -> None:
    service, _ = memory_provider_wiring(provider, user_home)
    for volume in (service or {}).get("volumes", []):
        Path(volume.split(":", 1)[0]).mkdir(parents=True, exist_ok=True)


def _check(label: str, ok: bool) -> int:
    typer.echo(f"{'ok' if ok else 'fail'} {label}")
    return 0 if ok else 1


def _is_private(path: Path) -> bool:
    return path.exists() and (path.stat().st_mode & 0o777) == 0o600


def _check_env_fresh(env_path: Path) -> int:
    if not env_path.exists():
        return _check(".env", False)
    present = {line.split("=", 1)[0] for line in env_path.read_text().splitlines() if "=" in line}
    stale = [key for key in REQUIRED_KEYS if key not in present]
    return _check(f".env stale (missing: {', '.join(stale)})" if stale else ".env fresh", not stale)


def _check_server_health() -> int:
    try:
        payload = server_get(_user_home(), "/health")
    except BetterAIError as exc:
        typer.echo(f"fail server health: {exc}")
        return 1
    typer.echo(f"ok server health: {json.dumps(payload)}")
    return 0


def _fail_loud(fn):
    """One attempt; on typed failure print the envelope and exit 1."""
    try:
        return fn()
    except BetterAIError as exc:
        _print_exit(exc)


def _print_exit(error: BetterAIError) -> None:
    typer.echo(json.dumps(error.envelope()), err=True)
    raise typer.Exit(1)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
