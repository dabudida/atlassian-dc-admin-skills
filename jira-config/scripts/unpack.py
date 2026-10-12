# -*- coding: utf-8 -*-
"""Unpack a jira-config snapshot zip into <root>/<instance>/jira-config and rebuild the indexes.

The zip comes from the ScriptRunner REST endpoint adapters/config-snapshot/JiraConfigSnapshotEndpoint.groovy:
  <baseUrl>/rest/scriptrunner/latest/custom/jiraConfigSnapshot

The instance folder is chosen by meta.baseUrl inside the zip, not by the file name:
instances.json next to SKILL.md maps hosts to folder names ({"jira.example.com": "prod"}).
A host missing from instances.json is refused unless --instance is given.

  python unpack.py                       newest jira-config-*.zip from Downloads / Desktop
  python unpack.py --zip path/to.zip
  python unpack.py --zip path/to.zip --instance prod
"""
import argparse
import json
import shutil
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_indexes  # noqa: E402

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

SKILL_DIR = Path(__file__).resolve().parents[1]
INSTANCES_FILE = SKILL_DIR / "instances.json"
SEARCH_DIRS = [Path.home() / "Downloads", Path.home() / "Desktop"]
SR_REPORT = "scriptrunner-report.zip"


def latest_download():
    """Newest jira-config-*.zip in Downloads and on the Desktop."""
    found = [path for folder in SEARCH_DIRS if folder.is_dir() for path in folder.glob("jira-config-*.zip")]
    if not found:
        raise SystemExit("No jira-config-*.zip in " + ", ".join(str(d) for d in SEARCH_DIRS) + "; pass --zip")
    return max(found, key=lambda path: path.stat().st_mtime)


def read_meta(archive):
    try:
        return json.loads(archive.read("meta.json").decode("utf-8"))
    except KeyError:
        raise SystemExit("meta.json is missing: this is not a jira-config snapshot")


def resolve_instance(meta, explicit):
    """Instance folder for the snapshot host: instances.json, else --instance."""
    host = (urlparse(meta.get("baseUrl") or "").hostname or "").lower()
    known = {}
    if INSTANCES_FILE.is_file():
        known = {key.lower(): value for key, value in json.loads(INSTANCES_FILE.read_text(encoding="utf-8")).items()}
    if host in known:
        if explicit and explicit != known[host]:
            raise SystemExit(f"{host} is mapped to '{known[host]}' in instances.json, not '{explicit}'")
        return known[host]
    if explicit:
        return explicit
    raise SystemExit(f"Snapshot from {host or 'an unknown host'}: add it to {INSTANCES_FILE} or pass --instance")


def unescape_json(cache_root):
    """Groovy JsonOutput writes non-ASCII as \\uXXXX; rewrite it as text so that grep by names works."""
    for path in cache_root.rglob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def extract_scriptrunner_report(cache_root):
    """Embedded ScriptRunner report -> <cache>/scriptrunner (same layout as the UI export). Returns the folder or None."""
    report = cache_root / SR_REPORT
    if not report.is_file():
        return None
    target = cache_root / "scriptrunner"
    with zipfile.ZipFile(report) as archive:
        archive.extractall(target)
    report.unlink()
    return target


def main():
    parser = argparse.ArgumentParser(description="Unpack a Jira configuration snapshot into <instance>/jira-config")
    parser.add_argument("--zip", help="jira-config-*.zip; default: the newest one in Downloads / Desktop")
    parser.add_argument("--instance", help="instance folder name when the host is not in instances.json")
    parser.add_argument("--root", default=str(build_indexes.PROJECT_ROOT), help="project root holding the instance folders")
    args = parser.parse_args()

    archive_path = Path(args.zip).resolve() if args.zip else latest_download()
    with zipfile.ZipFile(archive_path) as archive:
        meta = read_meta(archive)
        instance = resolve_instance(meta, args.instance)
        instance_dir = Path(args.root) / instance
        instance_dir.mkdir(parents=True, exist_ok=True)
        cache_root = instance_dir / build_indexes.CACHE_DIR
        if cache_root.is_dir():
            shutil.rmtree(cache_root)
        cache_root.mkdir()
        entry_count = len(archive.namelist())
        archive.extractall(cache_root)
    sr_root = extract_scriptrunner_report(cache_root)
    unescape_json(cache_root)

    build_indexes.update_sources(str(cache_root), {
        "configZip": archive_path.name,
        "configGeneratedAt": meta.get("generatedAt"),
        "baseUrl": meta.get("baseUrl"),
        "jiraVersion": meta.get("jiraVersion"),
        "excludedProjectCategories": meta.get("excludedProjectCategories") or [],
    })

    print("instance", instance, meta.get("baseUrl"))
    print("cache", cache_root)
    print("zip", archive_path, archive_path.stat().st_size, "bytes,", entry_count, "entries")
    print("generatedAt", meta.get("generatedAt"), "| jira", meta.get("jiraVersion"))
    counts = meta.get("counts") or {}
    print(" ".join(f"{key}={value}" for key, value in counts.items()))
    if meta.get("skippedSections"):
        print("skipped", ", ".join(meta["skippedSections"]))
    if meta.get("restBase"):
        print("rest", meta["restBase"])
    if sr_root:
        print("scriptrunner-report", sr_root)
    errors_path = cache_root / "errors.json"
    if errors_path.is_file():
        errors = json.loads(errors_path.read_text(encoding="utf-8"))
        for error in errors[:10]:
            print("  error", error.get("scope"), error.get("key"), "-", error.get("message"))
        if len(errors) > 10:
            print("  ... errors in total:", len(errors), "- see errors.json")

    build_indexes.build(instance, args.root)


if __name__ == "__main__":
    main()
