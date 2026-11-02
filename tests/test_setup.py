"""Filesystem safety checks; every installation stays inside a temporary directory."""

from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "panel_setup.py"
SPEC = importlib.util.spec_from_file_location("panel_setup", SCRIPT)
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / "source with spaces"
        self.project = self.base / "project with spaces"
        self.home = self.base / "fake home"
        for folder in (self.source, self.project, self.home):
            folder.mkdir()
        self.write("SKILL.md", '---\nname: panel\nmetadata:\n  version: "3.0.0"\n---\npanel\n')
        self.write("reference/roles.md", "roles\n")
        self.write("reference/profile.example.md", "public example\n")
        self.write("adapters/generic.md", "adapter\n")
        self.write("scout/SKILL.md", "---\nname: scout\n---\nscout\n")
        self.write("scout/reference/vetting.md", "vetting\n")
        self.write("scout/scripts/scan_skill.py", "print('scan')\n")
        self.write("scout/registry/README.md", "registry\n")
        self.skills, self.instructions = setup.locations("codex", "repo", self.project)

    def write(self, relative, content):
        path = self.source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def install(self, **kwargs):
        with redirect_stdout(io.StringIO()):
            setup.install(self.source, self.skills, self.instructions, **kwargs)

    def link(self, target, link):
        link.parent.mkdir(parents=True, exist_ok=True)
        try:
            link.symlink_to(target, target_is_directory=target.is_dir())
        except (NotImplementedError, OSError) as exc:
            self.skipTest("Symlinks unavailable: {}".format(exc))

    def snapshot(self, root):
        return {p.relative_to(root).as_posix(): p.read_bytes()
                for p in root.rglob("*") if p.is_file()}

    def test_locations_are_host_and_scope_specific(self):
        self.assertEqual(self.skills, self.project / ".agents/skills")
        self.assertEqual(self.instructions, self.project / "AGENTS.md")
        self.assertEqual(setup.locations("codex", "user", self.project, self.home),
                         (self.home / ".agents/skills", self.home / ".codex/AGENTS.md"))
        self.assertEqual(setup.locations("claude-code", "repo", self.project),
                         (self.project / ".claude/skills", self.project / "CLAUDE.md"))
        self.assertEqual(setup.locations("claude-code", "user", self.project, self.home),
                         (self.home / ".claude/skills", self.home / ".claude/CLAUDE.md"))

    def test_install_is_idempotent_and_manifest_contains_only_runtime_hashes(self):
        self.install()
        before = self.snapshot(self.project)
        times = {p: p.stat().st_mtime_ns for p in self.project.rglob("*") if p.is_file()}
        self.install()
        self.assertEqual(before, self.snapshot(self.project))
        self.assertEqual(times, {p: p.stat().st_mtime_ns for p in self.project.rglob("*") if p.is_file()})
        marker = json.loads((self.skills / "panel" / setup.MANIFEST).read_text())
        self.assertEqual(marker["format_version"], 1)
        self.assertEqual(marker["package"], "panel")
        self.assertEqual(marker["skill_version"], "3.0.0")
        self.assertEqual(len(marker["files"]["SKILL.md"]), 64)
        self.assertNotIn(str(self.source), json.dumps(marker))
        self.assertFalse(self.instructions.exists())

    def test_existing_unmanaged_panel_is_not_overwritten(self):
        target = self.skills / "panel"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("user data")
        with self.assertRaises(setup.SetupError):
            self.install()
        self.assertEqual((target / "SKILL.md").read_text(), "user data")
        self.assertFalse((self.skills / "scout").exists())

    def test_conflicting_scout_is_preflighted_before_creating_panel(self):
        target = self.skills / "scout"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("custom scout")
        with self.assertRaises(setup.SetupError):
            self.install(with_instructions=True)
        self.assertFalse((self.skills / "panel").exists())
        self.assertFalse(self.instructions.exists())
        self.assertEqual((target / "SKILL.md").read_text(), "custom scout")

    def test_modified_or_contaminated_install_is_never_updated(self):
        self.install()
        target = self.skills / "panel"
        (target / "SKILL.md").write_text("user changed skill")
        with self.assertRaises(setup.SetupError):
            self.install()
        self.assertEqual((target / "SKILL.md").read_text(), "user changed skill")
        (target / "SKILL.md").write_bytes((self.source / "SKILL.md").read_bytes())
        (target / "user-private.txt").write_text("private")
        with self.assertRaises(setup.SetupError):
            self.install()
        self.assertEqual((target / "user-private.txt").read_text(), "private")

    def test_changed_source_requires_manual_review(self):
        self.install()
        old = (self.skills / "panel/SKILL.md").read_bytes()
        self.write("SKILL.md", "new version\n")
        with self.assertRaises(setup.SetupError):
            self.install()
        self.assertEqual((self.skills / "panel/SKILL.md").read_bytes(), old)

    def test_instruction_append_preserves_every_original_byte(self):
        original = "# Мои правила\r\nНе удалять.\r\n".encode("utf-8")
        self.instructions.write_bytes(original)
        self.install(with_instructions=True)
        after = self.instructions.read_bytes()
        self.assertTrue(after.startswith(original))
        self.assertEqual(after.count(setup.START.encode()), 1)
        self.install(with_instructions=True)
        self.assertEqual(self.instructions.read_bytes(), after)

    def test_instruction_conflict_blocks_entire_install(self):
        original = "# User\n{}\ncustom block\n{}\n".format(setup.START, setup.END)
        self.instructions.write_text(original)
        with self.assertRaises(setup.SetupError):
            self.install(with_instructions=True)
        self.assertFalse(self.skills.exists())
        self.assertEqual(self.instructions.read_text(), original)

    def test_broken_instruction_marker_is_not_silently_appended(self):
        self.instructions.write_text(setup.START)
        with self.assertRaises(setup.SetupError):
            self.install(with_instructions=True)
        self.assertFalse(self.skills.exists())

    def test_symlink_destination_and_ancestor_cannot_escape_project(self):
        outside = self.base / "outside"
        outside.mkdir()
        self.link(outside, self.project / ".agents")
        with self.assertRaises(setup.SetupError):
            self.install()
        self.assertEqual(list(outside.iterdir()), [])

    def test_symlink_skill_and_instructions_are_refused(self):
        outside = self.base / "private.md"
        outside.write_text("keep")
        self.link(outside, self.instructions)
        with self.assertRaises(setup.SetupError):
            self.install(with_instructions=True)
        self.assertFalse(self.skills.exists())
        self.assertEqual(outside.read_text(), "keep")
        self.instructions.unlink()
        self.link(self.source, self.skills / "panel")
        with self.assertRaises(setup.SetupError):
            self.install()

    def test_source_symlink_is_rejected_before_copying_private_data(self):
        private = self.base / "private.txt"
        private.write_text("secret")
        self.link(private, self.source / "reference/private.md")
        with self.assertRaises(setup.SetupError):
            self.install()
        self.assertFalse(self.skills.exists())

    def test_missing_source_skill_prevents_partial_install(self):
        (self.source / "scout/SKILL.md").unlink()
        with self.assertRaises(setup.SetupError):
            self.install()
        self.assertFalse(self.skills.exists())

    def test_invalid_source_text_is_preflighted_before_any_write(self):
        (self.source / "scout/SKILL.md").write_bytes(b"\xff\xfe")
        with self.assertRaises(setup.SetupError):
            self.install()
        self.assertFalse(self.skills.exists())

    def test_copy_failure_removes_only_new_packages_and_preserves_instructions(self):
        original = b"# Keep these instructions\n"
        self.instructions.write_bytes(original)
        real_open = Path.open

        def failing_open(path, *args, **kwargs):
            if path == self.skills / "scout/SKILL.md":
                raise OSError("simulated write failure")
            return real_open(path, *args, **kwargs)

        with mock.patch.object(Path, "open", failing_open):
            with self.assertRaises(OSError):
                self.install(with_instructions=True)
        self.assertFalse((self.skills / "panel").exists())
        self.assertFalse((self.skills / "scout").exists())
        self.assertEqual(self.instructions.read_bytes(), original)

    def test_install_inside_source_copies_whitelist_without_recursion(self):
        self.write(".git/config", "not runtime")
        self.write(".agents/skills/other/SKILL.md", "not runtime")
        self.write(".claude/skills/other/SKILL.md", "not runtime")
        self.write("reference/profile.md", "private profile")
        self.write("learned.md", "private learned")
        self.skills, self.instructions = setup.locations("codex", "repo", self.source)
        self.install()
        installed = self.skills / "panel"
        self.assertFalse((installed / ".git").exists())
        self.assertFalse((installed / ".agents").exists())
        self.assertFalse((installed / ".claude").exists())
        self.assertFalse((installed / "scout").exists())
        self.assertFalse((installed / "reference/profile.md").exists())
        self.assertFalse((installed / "learned.md").exists())
        self.assertTrue((self.skills / "scout/scripts/scan_skill.py").is_file())
        before = self.snapshot(self.source)
        self.install()
        self.assertEqual(before, self.snapshot(self.source))

    def test_projects_inside_copied_runtime_trees_are_rejected_before_writes(self):
        self.write("agents/example.md", "agent fixture\n")
        trees = ("reference", "adapters", "agents", "scout/reference", "scout/registry", "scout/scripts")
        for tree in trees:
            for host in ("codex", "claude-code"):
                with self.subTest(tree=tree, host=host):
                    project = self.source / tree
                    self.skills, self.instructions = setup.locations(host, "repo", project)
                    before = self.snapshot(self.source)
                    with self.assertRaisesRegex(setup.SetupError, "copied runtime content"):
                        self.install(with_instructions=True)
                    self.assertEqual(before, self.snapshot(self.source))
                    self.assertFalse(self.skills.exists())
                    self.assertFalse(self.instructions.exists())

    def test_instruction_destination_inside_source_payload_is_also_rejected(self):
        self.instructions = self.source / "reference/AGENTS.md"
        with self.assertRaisesRegex(setup.SetupError, "copied runtime content"):
            self.install(with_instructions=True)
        self.assertFalse(self.skills.exists())
        self.assertFalse(self.instructions.exists())

    def test_targets_cannot_overlap_either_source_package_root(self):
        before = self.snapshot(self.source)
        self.skills = self.source  # scout target would be the source scout itself.
        with self.assertRaisesRegex(setup.SetupError, "source package root"):
            self.install()
        self.assertEqual(before, self.snapshot(self.source))
        self.assertFalse((self.source / "panel").exists())

        renamed = self.base / "panel"
        self.source.rename(renamed)
        self.source = renamed
        self.skills = self.base  # panel target would be the source panel itself.
        with self.assertRaisesRegex(setup.SetupError, "source package root"):
            self.install()
        self.assertEqual(before, self.snapshot(self.source))
        self.assertFalse((self.base / "scout").exists())

    def test_scout_source_as_project_excludes_nested_installs_for_both_hosts(self):
        for host in ("codex", "claude-code"):
            with self.subTest(host=host):
                self.skills, self.instructions = setup.locations(host, "repo", self.source / "scout")
                self.install(with_instructions=True)
                before = self.snapshot(self.source)
                self.install(with_instructions=True)
                self.assertEqual(before, self.snapshot(self.source))
                installed_scout = self.skills / "scout"
                self.assertFalse((installed_scout / ".agents").exists())
                self.assertFalse((installed_scout / ".claude").exists())
                self.assertTrue((installed_scout / "scripts/scan_skill.py").is_file())

    def test_doctor_missing_skill_is_read_only(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--host", "codex",
                                 "--project", str(self.project)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("MISSING", result.stdout)
        self.assertIn("UNVERIFIED", result.stdout)
        self.assertEqual(list(self.project.iterdir()), [])

    def test_doctor_on_existing_install_does_not_claim_runtime_success(self):
        self.install(with_instructions=True)
        before = self.snapshot(self.project)
        output = io.StringIO()
        with redirect_stdout(output):
            status = setup.doctor(self.skills, self.instructions)
        self.assertEqual(status, 0)
        self.assertIn("fingerprints not verified", output.getvalue())
        self.assertIn("delegation, and auto-routing are UNVERIFIED", output.getvalue())
        self.assertEqual(before, self.snapshot(self.project))

    def test_doctor_detects_broken_or_incomplete_install_markers_with_failure_status(self):
        self.install()
        marker = self.skills / "panel" / setup.MANIFEST
        valid = json.loads(marker.read_text())
        cases = [b"not-json", b"{}", json.dumps(dict(valid, files={})).encode(),
                 json.dumps(dict(valid, package="wrong")).encode(),
                 json.dumps(dict(valid, format_version=True)).encode(),
                 json.dumps(dict(valid, files={"SKILL.md": "bad-hash"})).encode(),
                 json.dumps(dict(valid, files={"SKILL.md": "0" * 64, "../secret": "0" * 64})).encode()]
        for data in cases:
            with self.subTest(marker=data):
                marker.write_bytes(data)
                before = self.snapshot(self.project)
                output = io.StringIO()
                with redirect_stdout(output):
                    status = setup.doctor(self.skills, self.instructions)
                self.assertEqual(status, 1)
                self.assertIn("install marker: invalid", output.getvalue())
                self.assertEqual(before, self.snapshot(self.project))

    def test_doctor_detects_corrupt_routing_with_failure_status_without_mutating_it(self):
        self.install(with_instructions=True)
        cases = [setup.START.encode(), setup.END.encode(),
                 (setup.END + "\n" + setup.START).encode(),
                 (setup.START + "\ncustom\n" + setup.END).encode(),
                 (setup.ROUTING + setup.ROUTING).encode(), b"\xff\xfe"]
        for data in cases:
            with self.subTest(routing=data):
                self.instructions.write_bytes(data)
                before = self.snapshot(self.project)
                with redirect_stdout(io.StringIO()):
                    status = setup.doctor(self.skills, self.instructions)
                self.assertEqual(status, 1)
                self.assertEqual(before, self.snapshot(self.project))

    def test_doctor_accepts_absent_optional_routing_and_unmanaged_skills(self):
        self.install()
        for name in ("panel", "scout"):
            (self.skills / name / setup.MANIFEST).unlink()
        before = self.snapshot(self.project)
        with redirect_stdout(io.StringIO()):
            status = setup.doctor(self.skills, self.instructions)
        self.assertEqual(status, 0)
        self.assertFalse(self.instructions.exists())
        self.assertEqual(before, self.snapshot(self.project))


if __name__ == "__main__":
    unittest.main()
