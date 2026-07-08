"""Input schema for start_container (no parameters: the compose file is
server configuration, never caller input)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class StartContainerInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


INPUT_MODEL = StartContainerInput
