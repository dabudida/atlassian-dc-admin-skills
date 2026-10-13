import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { it } from "node:test";

const SOURCES = new URL("../../adapters/workflow-xml/", import.meta.url);
const SHIPPED = new URL("../../atlassian-dc-admin/scripts/workflow-xml/", import.meta.url);

it("ships all workflow adapter sources beside the rebuilt CLI", () => {
  const names = readdirSync(SOURCES).filter((n) => n.endsWith(".groovy")).sort();
  assert.deepEqual(names, ["AdapterConflict.groovy", "AdapterRejection.groovy", "ImportedDraft.groovy", "WorkflowUsage.groovy", "WorkflowXmlEndpoints.groovy", "WorkflowXmlService.groovy", "WorkflowXmlSupport.groovy", "XmlInputRejected.groovy"]);
  assert.deepEqual(readdirSync(SHIPPED).sort(), names, "run pnpm build to refresh the shipped adapter copy");
  for (const name of names) {
    assert.equal(readFileSync(new URL(name, SHIPPED), "utf8"), readFileSync(new URL(name, SOURCES), "utf8"), `${name} is stale; run pnpm build`);
  }
});
