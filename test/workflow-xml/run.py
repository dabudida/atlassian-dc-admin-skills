"""Compile trusted adapter sources and run inert descriptor fixtures without Jira credentials."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--jar-root", required=True)
parser.add_argument("--java", default="java")
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
manifest = json.loads((Path(__file__).parent / "classpath.json").read_text())
jars = [Path(args.jar_root) / name for name in manifest["jars"]]
missing = [str(p) for p in jars if not p.is_file()]
if missing:
    print(json.dumps({"status": "UNAVAILABLE", "missing": missing}))
    raise SystemExit(2)
source = root / "adapters/workflow-xml"
if not (source / "WorkflowXmlSupport.groovy").is_file():
    raise AssertionError("WorkflowXmlSupport.groovy has not been implemented")
environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "en_US.UTF-8"}
classpath = os.pathsep.join(map(str, jars))
with tempfile.TemporaryDirectory(prefix="workflow-xml-") as build:
    sources = sorted(map(str, source.glob("*.groovy")))
    subprocess.run([args.java, "-cp", classpath, "org.codehaus.groovy.tools.FileSystemCompiler", "-d", build, *sources], env=environment, check=True)
    subprocess.run([args.java, "-cp", build + os.pathsep + classpath, "groovy.ui.GroovyMain", str(Path(__file__).parent / "fixtures.groovy")], env=environment, check=True)
    print(json.dumps({"status": "PASS_LOCAL", "live": "NOT_RUN", "jars": [{"path": name, "sha256": hashlib.sha256(jar.read_bytes()).hexdigest()} for name, jar in zip(manifest["jars"], jars)]}))
