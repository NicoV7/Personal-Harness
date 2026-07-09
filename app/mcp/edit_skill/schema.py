"""Input schema for edit_skill (the ONLY writable tool).

ArtifactInput/AppliesWhenInput live in app/corpus/writer.py (the shared
corpus write path); they are re-exported here so the tool schema module
keeps owning its INPUT_MODEL contract.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.corpus.writer import AppliesWhenInput, ArtifactInput

__all__ = ["AppliesWhenInput", "ArtifactInput", "EditSkillInput", "INPUT_MODEL"]


class EditSkillInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifact: ArtifactInput
    scope: Literal["global", "repo"]


INPUT_MODEL = EditSkillInput
