"""CorpusReader: frontmatter parsing, scope override, fail-loud invalids."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from app.corpus.reader import CorpusReader
from app.errors import ArtifactInvalidError


class TestRead:
    def test_parses_rule_frontmatter_and_stamps_kind_scope_hash(self, corpus_root):
        # arrange
        reader = CorpusReader(str(corpus_root))
        # act
        artifacts = reader.read()
        # assert
        rule = next(a for a in artifacts if a.id == "fail-loud-no-retries")
        assert rule.artifact_type == "rule"
        assert rule.scope == "global"
        assert rule.title == "Fail loud, never retry"
        assert rule.severity == "high"
        assert rule.applies_when is not None
        assert rule.applies_when.intents == ["error handling"]
        assert "## Anti-patterns" in rule.body
        raw = Path(rule.source_path).read_text(encoding="utf-8")
        assert rule.content_hash == hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def test_skills_directory_yields_skill_kind_with_forced_flag(self, corpus_root):
        # arrange
        reader = CorpusReader(str(corpus_root))
        # act
        artifacts = reader.read()
        # assert
        skill = next(a for a in artifacts if a.id == "write-scoped-plan")
        assert skill.artifact_type == "skill"
        assert skill.forced is True
        assert skill.when_to_use == "Before any multi-file change"

    def test_meta_directories_are_skipped(self, corpus_root):
        # arrange
        reader = CorpusReader(str(corpus_root))
        # act (would raise ArtifactInvalidError if _meta/schema.md were visited)
        artifacts = reader.read()
        # assert
        relative_parts = (
            Path(a.source_path).relative_to(corpus_root).parts for a in artifacts
        )
        assert all("_meta" not in parts for parts in relative_parts)

    def test_repo_overrides_global_on_id_collision(self, corpus_root, repo_root):
        # arrange
        reader = CorpusReader(str(corpus_root), repo_root=str(repo_root))
        # act
        artifacts = reader.read()
        # assert
        matching = [a for a in artifacts if a.id == "fail-loud-no-retries"]
        assert len(matching) == 1
        assert matching[0].scope == "repo"
        assert matching[0].title == "Repo override"
        assert reader.overridden_global_ids() == ["fail-loud-no-retries"]

    def test_overridden_ids_empty_without_repo_root(self, corpus_root):
        # arrange
        reader = CorpusReader(str(corpus_root))
        # act / assert
        assert reader.overridden_global_ids() == []


class TestParseCache:
    def test_unchanged_files_are_not_reparsed(self, corpus_root, monkeypatch):
        # arrange
        reader = CorpusReader(str(corpus_root))
        reader.read()
        reads: list[str] = []
        original = Path.read_text

        def counting_read_text(self, *args, **kwargs):
            reads.append(str(self))
            return original(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", counting_read_text)

        # act
        second = reader.read()

        # assert: stat-validated reuse — no file content is re-read
        assert reads == []
        assert len(second) > 0

    def test_changed_file_is_visible_next_read(self, corpus_root):
        # arrange
        reader = CorpusReader(str(corpus_root))
        before = reader.find("fail-loud-no-retries")
        path = Path(before.source_path)
        raw = path.read_text(encoding="utf-8")
        path.write_text(
            raw.replace("Fail loud, never retry", "Fail loud v2"), encoding="utf-8"
        )

        # act
        after = reader.find("fail-loud-no-retries")

        # assert
        assert after.title == "Fail loud v2"

    def test_deleted_file_disappears_next_read(self, corpus_root):
        # arrange
        reader = CorpusReader(str(corpus_root))
        target = Path(reader.find("write-pytest-fixture").source_path)

        # act
        target.unlink()
        artifacts = reader.read()

        # assert
        assert all(a.id != "write-pytest-fixture" for a in artifacts)


class TestFind:
    def test_find_returns_artifact_of_any_kind(self, corpus_root):
        # arrange
        reader = CorpusReader(str(corpus_root))
        # act / assert
        assert reader.find("fail-loud-no-retries").artifact_type == "rule"
        assert reader.find("write-pytest-fixture").artifact_type == "skill"

    def test_find_unknown_id_returns_none(self, corpus_root):
        # arrange
        reader = CorpusReader(str(corpus_root))
        # act / assert
        assert reader.find("does-not-exist") is None


class TestInvalidFilesFailLoud:
    def test_missing_frontmatter_raises_bai_410(self, corpus_root):
        # arrange
        bad = corpus_root / "rules" / "STANDARDS" / "broken" / "no-frontmatter.md"
        bad.parent.mkdir(parents=True, exist_ok=True)
        bad.write_text("just prose, no frontmatter", encoding="utf-8")
        # act
        with pytest.raises(ArtifactInvalidError) as excinfo:
            CorpusReader(str(corpus_root)).read()
        # assert
        assert excinfo.value.code == "BAI-410"
        assert "no-frontmatter.md" in str(excinfo.value)

    def test_unparseable_yaml_raises_bai_410(self, corpus_root):
        # arrange
        bad = corpus_root / "rules" / "STANDARDS" / "broken" / "bad-yaml.md"
        bad.parent.mkdir(parents=True, exist_ok=True)
        bad.write_text("---\nid: [unclosed\n---\n\nbody", encoding="utf-8")
        # act / assert
        with pytest.raises(ArtifactInvalidError):
            CorpusReader(str(corpus_root)).read()

    def test_missing_required_field_names_it(self, corpus_root, rule_body, write_markdown):
        # arrange (no title)
        write_markdown(
            corpus_root / "rules" / "STANDARDS" / "broken" / "no-title.md",
            "id: no-title\ncategory: STANDARDS",
            rule_body,
        )
        # act
        with pytest.raises(ArtifactInvalidError) as excinfo:
            CorpusReader(str(corpus_root)).read()
        # assert
        assert "title" in str(excinfo.value)
