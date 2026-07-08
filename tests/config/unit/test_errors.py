"""Typed errors carry stable codes and a uniform wire envelope."""

from app.errors import (
    EditOutsideManifestError,
    Errors,
    StackUnavailableError,
)


class TestEnvelope:
    def test_envelope_has_code_and_message(self):
        # arrange
        error = Errors.unauthorized()
        # act
        envelope = error.envelope()
        # assert
        assert envelope == {"error": "BAI-201", "message": "unauthorized"}


class TestFactories:
    def test_stack_unavailable_prompts_to_start_the_stack(self):
        # arrange / act
        error = Errors.stack_unavailable("redis", "connection refused")
        # assert
        assert isinstance(error, StackUnavailableError)
        assert error.code == "BAI-601"
        assert "betterai start" in str(error)

    def test_edit_outside_manifest_names_path_and_escape_hatch(self):
        # arrange / act
        error = Errors.edit_outside_manifest("/repo/src/rogue.py")
        # assert
        assert isinstance(error, EditOutsideManifestError)
        assert error.code == "BAI-702"
        assert "/repo/src/rogue.py" in str(error)
        assert "justify:" in str(error)

    def test_config_missing_lists_each_key_on_own_line(self):
        # arrange / act
        error = Errors.config_missing(["KEY_A", "KEY_B"])
        # assert
        assert "  - KEY_A" in str(error)
        assert "  - KEY_B" in str(error)

    def test_receipt_missing_names_query_skills(self):
        # arrange / act
        error = Errors.receipt_missing("Edit")
        # assert
        assert error.code == "BAI-701"
        assert "query_skills" in str(error)
