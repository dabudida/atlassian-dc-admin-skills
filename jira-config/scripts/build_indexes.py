# -*- coding: utf-8 -*-
"""Build the ScriptRunner and Automation indexes in <root>/<instance>/jira-config/index.

Sources, newest first:
  ScriptRunner report  <instance>/jira-config/scriptrunner/   (embedded in the snapshot)
                       <instance>/scriptrunner/                (a manually unpacked scriptrunner-report*.zip)
  Automation export    <instance>/jira-config/automation-rules.json   (embedded in the snapshot)
                       <instance>/automation/automation-rules-*.json  (manual exports, newest by name)

  python build_indexes.py --instance prod
  python build_indexes.py --instance prod --automation path/to/automation-rules.json

Project keys in the Automation index come from the snapshot (projects/*.json),
so unpack.py rebuilds the indexes itself after every snapshot.
"""
import argparse
import glob
import json
import os
import sys
from pathlib import Path

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

def default_root():
    """JIRA_CONFIG_ROOT, else the folder holding .claude when the skill is installed there, else the current folder."""
    if os.environ.get("JIRA_CONFIG_ROOT"):
        return Path(os.environ["JIRA_CONFIG_ROOT"])
    for parent in Path(__file__).resolve().parents:
        if parent.name == ".claude":
            return parent.parent
    return Path.cwd()


PROJECT_ROOT = default_root()
CACHE_DIR = "jira-config"

FEATURE_FOLDERS = [
    ("behaviours", "behaviour"),
    ("jqlFunctionFilters", "jql"),
    ("scriptFields", "script-field"),
    ("restConfigItems", "rest"),
    ("scriptJobs", "job"),
    ("fragmentConfigItems", "fragment"),
    ("scriptListeners", "listener"),
    ("resources", "resource"),
]


def load_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def cell(value):
    """TSV cell on one line without tabs."""
    text = "" if value is None else str(value)
    return text.replace("\t", " ").replace("\r", " ").replace("\n", " ")


def flag_cell(value):
    return "True" if value else "False"


def write_tsv(path, columns, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\t".join(columns) + "\n")
        for row in rows:
            handle.write("\t".join(cell(row[column]) for column in columns) + "\n")


def script_paths(node, acc=None):
    """All scriptPath values of a nested ScriptRunner feature JSON."""
    if acc is None:
        acc = []
    if isinstance(node, dict):
        path = node.get("scriptPath")
        if isinstance(path, str) and path.strip():
            acc.append(path.strip())
        for value in node.values():
            script_paths(value, acc)
    elif isinstance(node, list):
        for value in node:
            script_paths(value, acc)
    return acc


def project_names(value):
    """Project keys from projects/relatedProjects: a string, {key}, or a list of either."""
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, dict):
        key = value.get("key") or value.get("name")
        return [str(key)] if key else []
    if isinstance(value, list):
        result = []
        for item in value:
            result.extend(project_names(item))
        return result
    return []


def feature_projects(data):
    for key in ("projects", "relatedProjects"):
        names = project_names(data.get(key))
        if names:
            return ",".join(dict.fromkeys(names))
    return ""


def build_features(sr_root):
    """sr-features.tsv rows: behaviours, listeners, jobs, REST endpoints, fragments, script fields, JQL functions."""
    rows = []
    for folder, kind in FEATURE_FOLDERS:
        for path in glob.glob(os.path.join(sr_root, folder, "*.json")):
            data = load_json(path)
            paths = list(dict.fromkeys(script_paths(data)))
            rows.append({
                "kind": kind,
                "id": str(data.get("id") or os.path.splitext(os.path.basename(path))[0]),
                "name": data.get("name") or data.get("FIELD_NOTES") or "",
                "disabled": flag_cell(data.get("disabled")),
                "projects": feature_projects(data),
                "script": "|".join(paths),
                "folder": folder,
            })
    rows.sort(key=lambda row: (row["kind"], row["name"].lower(), row["id"]))
    return rows


def function_script(params):
    """Script path of a post-function, validator or condition; empty for inline code."""
    script = params.get("scriptPath") or ""
    if script:
        return script
    raw = params.get("FIELD_SCRIPT_FILE_OR_SCRIPT")
    if isinstance(raw, dict):
        return raw.get("scriptPath") or ""
    if isinstance(raw, str) and raw.strip().startswith("{"):
        try:
            return json.loads(raw).get("scriptPath") or ""
        except json.JSONDecodeError:
            return ""
    return ""


def build_workflow_functions(sr_root):
    """sr-workflow-functions.tsv rows: which script runs on which transition."""
    rows = []
    for path in glob.glob(os.path.join(sr_root, "workflowFunctions", "*.json")):
        data = load_json(path)
        info = data.get("workflowFunctionInfo") or {}
        transition = info.get("transition") or {}
        starts = transition.get("startSteps") or []
        end = transition.get("endStep") or {}
        rows.append({
            "id": str(data.get("id") or os.path.splitext(os.path.basename(path))[0]),
            "workflow": info.get("name") or "",
            "draft": flag_cell(info.get("isDraft")),
            "transition": transition.get("name") or "",
            "transitionId": str(transition.get("id") or ""),
            "from": "|".join(step.get("name") or "" for step in starts),
            "to": end.get("name") or "",
            "kind": info.get("functionType") or "",
            "function": info.get("functionName") or "",
            "script": function_script(data.get("scriptParams") or {}),
            "disabled": flag_cell(info.get("disabled")),
        })
    rows.sort(key=lambda row: (row["workflow"].lower(), row["transition"].lower(), row["id"]))
    return rows


def project_keys(cache_root):
    """Project id -> key from the snapshot projects/*.json."""
    mapping = {}
    for path in glob.glob(os.path.join(cache_root, "projects", "*.json")):
        data = load_json(path)
        if data.get("id") is not None and data.get("key"):
            mapping[str(data["id"])] = data["key"]
    return mapping


def build_automation(automation_path, keys):
    """automation-rules.tsv rows: id, state, name, trigger, projects."""
    rows = []
    for rule in load_json(automation_path).get("rules") or []:
        projects = [
            keys.get(str(item.get("projectId") or ""), str(item.get("projectId") or ""))
            for item in rule.get("projects") or []
        ]
        rows.append({
            "id": str(rule.get("id") or ""),
            "state": rule.get("state") or "",
            "name": rule.get("name") or "",
            "trigger": (rule.get("trigger") or {}).get("type") or "",
            "projects": ",".join(projects) if projects else "(global)",
        })
    rows.sort(key=lambda row: (row["name"].lower(), row["id"]))
    return rows


def default_sr_root(instance_dir, cache_root):
    """The report embedded in the snapshot, else a manually unpacked one."""
    embedded = os.path.join(cache_root, "scriptrunner")
    if os.path.isdir(os.path.join(embedded, "workflowFunctions")):
        return embedded
    return os.path.join(instance_dir, "scriptrunner")


def default_automation(instance_dir, cache_root):
    """The export embedded in the snapshot, else the newest automation-rules-*.json (YYYYMMDDHHMM in the name)."""
    embedded = os.path.join(cache_root, "automation-rules.json")
    if os.path.isfile(embedded):
        return embedded
    found = sorted(glob.glob(os.path.join(instance_dir, "automation", "automation-rules-*.json")))
    return found[-1] if found else None


def update_sources(cache_root, values):
    path = os.path.join(cache_root, "sources.json")
    data = load_json(path) if os.path.isfile(path) else {}
    data.update(values)
    os.makedirs(cache_root, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def build(instance, root=PROJECT_ROOT, sr_report=None, automation=None):
    """Rebuild the indexes of an instance. Without explicit paths the sources are found as described above."""
    instance_dir = os.path.join(str(root), instance)
    cache_root = os.path.join(instance_dir, CACHE_DIR)
    index = os.path.join(cache_root, "index")
    sources = {}

    sr_root = os.path.abspath(sr_report or default_sr_root(instance_dir, cache_root))
    if os.path.isdir(os.path.join(sr_root, "workflowFunctions")):
        features = build_features(sr_root)
        functions = build_workflow_functions(sr_root)
        write_tsv(os.path.join(index, "sr-features.tsv"),
                  ["kind", "id", "name", "disabled", "projects", "script", "folder"], features)
        write_tsv(os.path.join(index, "sr-workflow-functions.tsv"),
                  ["id", "workflow", "draft", "transition", "transitionId", "from", "to",
                   "kind", "function", "script", "disabled"], functions)
        sources["scriptRunnerReport"] = sr_root
        sources["srcRoot"] = os.path.join(sr_root, "default_script_root_scripts")
        meta_path = os.path.join(sr_root, "instance-information", "sr-metadata.json")
        if os.path.isfile(meta_path):
            meta = load_json(meta_path)
            sources["srReportJira"] = meta.get("hostAppVersion")
            sources["srReportScriptRunner"] = meta.get("scriptRunnerVersion")
        print("sr-features", len(features))
        print("sr-workflow-functions", len(functions))
    else:
        print("ScriptRunner: no", os.path.join(sr_root, "workflowFunctions"), "- SR indexes not updated")

    automation_path = automation or default_automation(instance_dir, cache_root)
    if automation_path:
        automation_path = os.path.abspath(automation_path)
        keys = project_keys(cache_root)
        rules = build_automation(automation_path, keys)
        write_tsv(os.path.join(index, "automation-rules.tsv"),
                  ["id", "state", "name", "trigger", "projects"], rules)
        sources["automationRules"] = automation_path
        print("automation-rules", len(rules), "from", os.path.basename(automation_path))
        if not keys:
            print("  no snapshot yet: project ids instead of keys")
    else:
        print("Automation: no export found")

    update_sources(cache_root, sources)


def main():
    parser = argparse.ArgumentParser(description="ScriptRunner and Automation indexes for <instance>/jira-config")
    parser.add_argument("--instance", required=True, help="instance folder name")
    parser.add_argument("--sr-report", help="unpacked ScriptRunner report folder")
    parser.add_argument("--automation", help="Automation export JSON")
    parser.add_argument("--root", default=str(PROJECT_ROOT), help="project root holding the instance folders")
    args = parser.parse_args()
    build(args.instance, args.root, args.sr_report, args.automation)


if __name__ == "__main__":
    main()
