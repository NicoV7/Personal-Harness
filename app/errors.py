"""Typed errors for the BetterAI harness.

Every error in the system carries a stable BAI-xxx code so clients,
dashboards, and the audit log can match on code instead of message text.
Call sites use the `Errors` factories; raising a bare Exception or
retrying/backing off instead of raising is a corpus-rule violation
(fail-loud-no-retries).

Code blocks:
  BAI-1xx  bootstrap / config
  BAI-2xx  auth / authz
  BAI-4xx  corpus / retrieval input
  BAI-6xx  providers / infrastructure (redis, postgres, openrouter, docker)
  BAI-7xx  hook gates
"""

from __future__ import annotations

from collections.abc import Sequence


class BetterAIError(Exception):
    code: str = "BAI-000"
    http_status: int = 500

    def __init__(self, message: str, *, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.cause = cause

    def envelope(self) -> dict[str, str]:
        return {"error": self.code, "message": str(self)}


class ConfigMissingError(BetterAIError):
    code = "BAI-120"


class ConfigInvalidError(BetterAIError):
    code = "BAI-121"


class UnauthorizedError(BetterAIError):
    code = "BAI-201"
    http_status = 401


class HostNotAllowedError(BetterAIError):
    code = "BAI-202"
    http_status = 401


class TokenMissingError(BetterAIError):
    code = "BAI-210"


class ArtifactNotFoundError(BetterAIError):
    code = "BAI-404"
    http_status = 404


class ArtifactInvalidError(BetterAIError):
    code = "BAI-410"
    http_status = 422


class StackUnavailableError(BetterAIError):
    code = "BAI-601"
    http_status = 503


class QueryError(BetterAIError):
    code = "BAI-602"


class IndexWriteError(BetterAIError):
    code = "BAI-603"


class EmbeddingProviderError(BetterAIError):
    code = "BAI-604"
    http_status = 502


class ContainerOpError(BetterAIError):
    code = "BAI-606"


class SourceFetchError(BetterAIError):
    code = "BAI-607"
    http_status = 502


class DistillError(BetterAIError):
    code = "BAI-608"
    http_status = 502


class ExpansionError(BetterAIError):
    code = "BAI-609"
    http_status = 502


class SkillsSyncError(BetterAIError):
    code = "BAI-610"
    http_status = 502


class ReadGateError(BetterAIError):
    code = "BAI-700"
    http_status = 403


class RetrievalReceiptMissingError(BetterAIError):
    code = "BAI-701"
    http_status = 403


class EditOutsideManifestError(BetterAIError):
    code = "BAI-702"
    http_status = 403


class EditBudgetExceededError(BetterAIError):
    code = "BAI-703"
    http_status = 403


START_PROMPT = "run `betterai start` to bring the local stack up"


class Errors:
    """Factories carrying the canonical message per code."""

    @staticmethod
    def config_missing(keys: Sequence[str]) -> ConfigMissingError:
        listing = "\n".join(f"  - {key}" for key in keys)
        return ConfigMissingError(
            f"missing required configuration keys (no defaults exist):\n{listing}"
        )

    @staticmethod
    def config_invalid(key: str, reason: str) -> ConfigInvalidError:
        return ConfigInvalidError(f"invalid configuration for {key}: {reason}")

    @staticmethod
    def unauthorized() -> UnauthorizedError:
        return UnauthorizedError("unauthorized")

    @staticmethod
    def host_not_allowed(host: str) -> HostNotAllowedError:
        return HostNotAllowedError(f"host not allowed: {host}")

    @staticmethod
    def token_missing(path: str) -> TokenMissingError:
        return TokenMissingError(
            f"bearer token not found at {path}; the installer writes it before startup"
        )

    @staticmethod
    def artifact_not_found(artifact_id: str) -> ArtifactNotFoundError:
        return ArtifactNotFoundError(f"no artifact with id {artifact_id!r}")

    @staticmethod
    def artifact_invalid(path: str, reason: str) -> ArtifactInvalidError:
        return ArtifactInvalidError(f"invalid artifact {path}: {reason}")

    @staticmethod
    def stack_unavailable(service: str, detail: str) -> StackUnavailableError:
        return StackUnavailableError(f"{service} unreachable ({detail}); {START_PROMPT}")

    @staticmethod
    def query_error(detail: str, *, cause: Exception | None = None) -> QueryError:
        return QueryError(f"retrieval query failed: {detail}", cause=cause)

    @staticmethod
    def index_write_error(detail: str, *, cause: Exception | None = None) -> IndexWriteError:
        return IndexWriteError(f"index write failed: {detail}", cause=cause)

    @staticmethod
    def embedding_provider(detail: str) -> EmbeddingProviderError:
        return EmbeddingProviderError(f"embedding provider request failed: {detail}")

    @staticmethod
    def container_op_failed(detail: str) -> ContainerOpError:
        return ContainerOpError(f"container operation failed: {detail}")

    @staticmethod
    def source_fetch_failed(url: str, detail: str) -> SourceFetchError:
        return SourceFetchError(f"source fetch failed for {url}: {detail}")

    @staticmethod
    def distill_failed(chunk_ref: str, detail: str) -> DistillError:
        return DistillError(f"distillation failed for chunk {chunk_ref}: {detail}")

    @staticmethod
    def expansion_failed(detail: str) -> ExpansionError:
        return ExpansionError(f"prompt expansion failed: {detail}")

    @staticmethod
    def skills_sync_failed(url: str, detail: str) -> SkillsSyncError:
        return SkillsSyncError(f"skills sync failed for {url}: {detail}")

    @staticmethod
    def read_gate_denied(skill_ids: Sequence[str]) -> ReadGateError:
        listing = ", ".join(skill_ids)
        return ReadGateError(
            f"Mutating tools are blocked until required BetterAI skills are read: {listing}. "
            "They are normally served inline by the prompt hook; this deny means that "
            "failed — call mcp__betterai__get_skill per id, or fix the stack "
            "(betterai doctor). BETTERAI_READ_GATE=off is the explicit override."
        )

    @staticmethod
    def receipt_missing(tool_name: str) -> RetrievalReceiptMissingError:
        return RetrievalReceiptMissingError(
            f"{tool_name} denied: no retrieval receipt for this turn. The prompt "
            "hook records it at delivery; this deny means that failed — check "
            "the harness warning in the prompt context, fix the stack (betterai "
            "doctor), or send a new message to start a fresh turn. "
            "BETTERAI_RECEIPT_GATE=off is the explicit override."
        )

    @staticmethod
    def edit_outside_manifest(path: str) -> EditOutsideManifestError:
        return EditOutsideManifestError(
            f"edit denied: {path} is not in the active plan manifest; "
            "add it to the plan's '## Files to touch' section with a justify: line"
        )

    @staticmethod
    def edit_budget_exceeded(granularity: str) -> EditBudgetExceededError:
        return EditBudgetExceededError(
            f"incremental mode ({granularity}): edit budget for this turn is used; "
            "stop and discuss the change with the user before continuing"
        )
