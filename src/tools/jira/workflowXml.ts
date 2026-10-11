/** Complete descriptors stay in local files; confirmation binds bytes and server fingerprints. */
import { z } from "zod";
import { lstat, open, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import type { AtlassianClient } from "../../client.js";
import { errorDetail, HttpStatusError, UnsupportedError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { dryRunShape } from "../util.js";
import { localTarget, sha256 } from "./scriptRoot.js";

const ROUTE = "/rest/scriptrunner/latest/custom/";
const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const metadataSchema = z.object({
  protocol: z.literal(1), jiraVersion: z.string().regex(/^11\.3\./), scriptRunnerVersion: z.string().regex(/^10\./),
  workflow: z.string().min(1).max(255), active: z.boolean(), system: z.boolean(),
  liveHash: HASH, draftHash: HASH.nullable(), draftNormalizedHash: HASH.nullable(),
  usage: z.object({ total: z.number().int().nonnegative(), projectIds: z.array(z.string().regex(/^\d+$/)).max(100), truncated: z.boolean() }),
});
type Metadata = z.infer<typeof metadataSchema>;
const manifestSchema = z.object({ schemaVersion: z.literal(1), source: z.string(), workflow: z.string(), mode: z.enum(["live", "draft"]),
  protocol: z.literal(1), jiraVersion: z.string(), scriptRunnerVersion: z.string(), liveHash: HASH, draftHash: HASH.nullable(), exportedXmlHash: HASH });
const approved = new WeakMap<AtlassianClient, Map<string, string>>();
const limitShape = { max_xml_bytes: z.number().int().min(1).max(20 * 1024 * 1024).default(5 * 1024 * 1024) };
const workflowShape = { workflow: z.string().min(1).max(255).describe("Exact workflow name") };
function source(client: AtlassianClient): string {
  const u = new URL(client.url("/")); u.username = ""; u.password = ""; u.search = ""; u.hash = "";
  return u.toString().replace(/\/$/, "");
}
const link = (client: AtlassianClient, workflow: string) => ({ url: client.url("/secure/admin/workflows/ViewWorkflowSteps.jspa", { workflowName: workflow }), verified: false });
/** Fixed adapter reasons (adapters/workflow-xml); any other error text may quote XML or scripts and is withheld. */
const REASONS = new Set([
  "Workflow XML exceeds byte limit", "Invalid workflow descriptor or unavailable secure parser", "Bundled workflow grammar unavailable", "External XML resolution refused",
  "Expected workflow root", "Unknown workflow status reference", "Unknown workflow screen reference", "Invalid adapter protocol or request identity", "Exact workflow not found",
  "Only an active non-system workflow can receive a draft", "Invalid workflow selection", "Requested draft does not exist", "Workflow fingerprints changed; preview again",
  "Draft verification failed; reread before retry", "Request exceeds byte limit", "Expected object", "Invalid protocol", "Administrator permission required",
  "Unsupported adapter pair", "Invalid workflow request or descriptor", "Workflow state conflict; reread before retry", "Adapter operation failed; reread before retry",
]);
const REASON_PATTERNS = [
  /^Invalid XML at line \d{1,9}, column \d{1,9}$/,
  /^Workflow XML does not match Jira's workflow grammar at line \d{1,9}, column \d{1,9}$/,
  /^Draft persistence failed; draftCreated=(true|false); reread before retry$/,
];
export function adapterReason(body: string): string | undefined {
  let reason: unknown;
  try { reason = JSON.parse(body)?.error; } catch { return undefined; }
  return typeof reason === "string" && (REASONS.has(reason) || REASON_PATTERNS.some((p) => p.test(reason as string))) ? reason : undefined;
}
async function call(client: AtlassianClient, method: string, route: string, opts: Parameters<AtlassianClient["request"]>[2] = {}) {
  try { return await client.request(method, ROUTE + route, opts); }
  catch (e) {
    const reason = e instanceof HttpStatusError ? adapterReason(e.body) : undefined;
    if (e instanceof HttpStatusError && e.status === 501 && reason === "Unsupported adapter pair") throw new UnsupportedError("Workflow XML adapter does not support this Jira/ScriptRunner version pair");
    if (e instanceof HttpStatusError && [404, 405, 501].includes(e.status)) throw new UnsupportedError("Workflow XML adapter unavailable; see WORKFLOW_XML.md for separate installation");
    if (e instanceof HttpStatusError) throw new HttpStatusError(e.status, reason ? JSON.stringify({ message: reason }) : "", `Workflow XML adapter ${route}`, method);
    throw new VerificationError(method === "PUT" ? "Draft mutation outcome is indeterminate; reread before a new approved attempt" : "Workflow XML adapter read/validation failed");
  }
}
function metadata(data: unknown, workflow: string): Metadata {
  const parsed = metadataSchema.safeParse(data);
  if (!parsed.success || parsed.data.workflow !== workflow) throw new UnsupportedError("Unrecognized workflow XML adapter contract or product pair");
  return parsed.data;
}
async function bytesFromFile(path: string, cap: number): Promise<Buffer> {
  let file;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > cap) throw new ValidationError("Local XML/manifest must be a regular file within the byte limit");
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (!before.isFile() || before.size > cap || before.ino !== stat.ino || before.dev !== stat.dev) throw new ValidationError("Local XML/manifest changed while opening");
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.length > cap || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new ValidationError("Local XML/manifest changed while reading");
    return bytes;
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError("Cannot read local XML/manifest as a regular file");
  } finally { await file?.close(); }
}
async function publishPair(output: string, relative: string, xml: Buffer, manifest: Buffer, overwrite: boolean) {
  const target = await localTarget(output, relative);
  let existing;
  try { existing = await lstat(target); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  if (existing) {
    if (!existing.isDirectory()) throw new ValidationError("Export generation is not a regular directory");
    const oldXml = await bytesFromFile(join(target, "workflow.xml"), 20 * 1024 * 1024);
    const oldManifest = await bytesFromFile(join(target, "manifest.json"), 64 * 1024);
    if (sha256(oldXml) === sha256(xml) && sha256(oldManifest) === sha256(manifest)) return { outcome: "ALREADY-SATISFIED", target };
    if (!overwrite) return { outcome: "CONFLICT", target };
  }
  const stage = await mkdtemp(join(resolve(output), ".workflow-stage-"));
  let backup: string | undefined;
  try {
    await writeFile(join(stage, "workflow.xml"), xml, { flag: "wx" });
    await writeFile(join(stage, "manifest.json"), manifest, { flag: "wx" });
    if (existing) {
      backup = `${target}.bak-${Date.now()}-${sha256(manifest).slice(0, 12)}`;
      try { await lstat(backup); throw new ValidationError("Export backup already exists"); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
      await rename(target, backup);
    }
    try { await rename(stage, target); }
    catch (e) { if (backup) await rename(backup, target); throw e; }
    return { outcome: existing ? "REPLACED" : "WRITTEN", target, ...(backup ? { backup } : {}) };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export const jiraWorkflowXmlTools: ToolDef[] = [{
  name: "jira_export_workflow_xml", product: "jira",
  description: "Export exactly one complete live/draft workflow XML and provenance manifest to a local generation. Requires a separately installed workflow XML adapter; never creates drafts.",
  inputShape: { ...workflowShape, ...limitShape, output_dir: z.string().min(1).describe("Existing output directory"), mode: z.enum(["live", "draft"]).default("live"), overwrite: z.boolean().default(false) },
  handler: async (ctx, args) => {
    const client = ctx.client("jira");
    const data: any = await call(client, "GET", "jiraWorkflowXml", { params: { protocol: 1, workflow: args.workflow, mode: args.mode, include_xml: true } });
    const info = metadata(data, args.workflow);
    if (typeof data.xml !== "string" || data.mode !== args.mode) throw new ValidationError("Requested workflow descriptor is unavailable");
    const xml = Buffer.from(data.xml, "utf8");
    if (xml.length > args.max_xml_bytes) throw new ValidationError("Workflow XML exceeds byte limit");
    const hash = sha256(xml);
    if (hash !== (args.mode === "live" ? info.liveHash : info.draftHash)) throw new VerificationError("Export descriptor fingerprint mismatch");
    const manifest = { schemaVersion: 1, source: source(client), workflow: info.workflow, mode: args.mode, protocol: info.protocol,
      jiraVersion: info.jiraVersion, scriptRunnerVersion: info.scriptRunnerVersion, liveHash: info.liveHash, draftHash: info.draftHash, exportedXmlHash: hash };
    const encoded = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    if (encoded.length > 64 * 1024) throw new ValidationError("Workflow manifest exceeds byte limit");
    const relative = `workflow-${sha256(Buffer.from(`${manifest.source}\n${args.workflow}\n${args.mode}`)).slice(0, 24)}`;
    const written = await publishPair(args.output_dir, relative, xml, encoded, args.overwrite);
    const counts = z.object({ steps: z.number().int().nonnegative(), initialActions: z.number().int().nonnegative(), globalActions: z.number().int().nonnegative() }).safeParse(data.counts);
    return { ...written, xml_file: join(written.target, "workflow.xml"), manifest_file: join(written.target, "manifest.json"), xmlHash: hash, manifestHash: sha256(encoded), bytes: xml.length,
      workflow: info.workflow, mode: args.mode, ...(counts.success ? { counts: counts.data } : {}), admin: link(client, info.workflow) };
  },
}, {
  name: "jira_import_workflow_xml_draft", product: "jira", write: true, invalidates: [],
  description: "Preview/confirm edited local XML into the draft of its source workflow. Manifest required; binds file and live/draft hashes. Never publishes. Adapter installation is separate.",
  inputShape: { ...workflowShape, ...limitShape, ...dryRunShape, xml_file: z.string().min(1), manifest_file: z.string().min(1) },
  handler: async (ctx, args) => {
    const client = ctx.client("jira");
    const [xml, manifestBytes] = await Promise.all([bytesFromFile(args.xml_file, args.max_xml_bytes), bytesFromFile(args.manifest_file, 64 * 1024)]);
    let xmlText: string;
    try { xmlText = new TextDecoder("utf-8", { fatal: true }).decode(xml); }
    catch { throw new ValidationError("Workflow XML must be valid UTF-8"); }
    let parsed;
    try { parsed = manifestSchema.safeParse(JSON.parse(manifestBytes.toString("utf8"))); } catch { throw new ValidationError("Malformed workflow provenance manifest"); }
    if (!parsed.success) throw new ValidationError("Invalid workflow provenance manifest");
    const manifest = parsed.data;
    if (manifest.source !== source(client) || manifest.workflow !== args.workflow) throw new ValidationError("Manifest source/workflow differs from the import target");
    metadata(await call(client, "GET", "jiraWorkflowXml", { params: { protocol: 1, workflow: args.workflow } }), args.workflow);
    const validation: any = await call(client, "POST", "jiraWorkflowXmlValidate", { json: { protocol: 1, workflow: args.workflow, xml: xmlText } });
    const info = metadata(validation, args.workflow);
    if (!info.active || info.system || !HASH.safeParse(validation.desiredNormalizedHash).success) throw new ValidationError("Only validated active non-system workflow drafts can be imported");
    const desiredHash = validation.desiredNormalizedHash as string;
    const identity = { workflow: args.workflow, source: manifest.source, xmlHash: sha256(xml), manifestHash: sha256(manifestBytes), desiredHash };
    const state = { liveHash: info.liveHash, draftHash: info.draftHash, usage: info.usage };
    const fingerprint = JSON.stringify({ identity, state });
    const key = JSON.stringify([args.workflow, resolve(args.xml_file), resolve(args.manifest_file)]);
    const request = { method: "PUT", url: client.url(ROUTE + "jiraWorkflowXmlDraft"), body: { xml: "<local XML withheld>", ...identity, expectedLiveHash: info.liveHash, expectedDraftHash: info.draftHash } };
    const common = { product: "jira", summary: `${info.draftHash ? "Replace" : "Create"} draft XML of '${args.workflow}'`, identity, state, request, affected: info.usage, admin: link(client, args.workflow) };
    if (info.draftNormalizedHash === desiredHash) return { ...common, already_satisfied: true, reason: "Desired draft descriptor already holds" };
    let cache = approved.get(client);
    if (!cache) { cache = new Map(); approved.set(client, cache); }
    if (args.dry_run !== false) {
      cache.set(key, fingerprint);
      return { ...common, dry_run: true, note: "Validation executed no scripts and created no draft. Requires exclusive draft editing window; publishing is separate." };
    }
    if (cache.get(key) !== fingerprint) throw new VerificationError("Approved file/provenance/workflow state changed or no matching preview exists; preview again");
    const [currentXml, currentManifest] = await Promise.all([bytesFromFile(args.xml_file, args.max_xml_bytes), bytesFromFile(args.manifest_file, 64 * 1024)]);
    if (sha256(currentXml) !== identity.xmlHash || sha256(currentManifest) !== identity.manifestHash) throw new VerificationError("Approved XML/manifest changed during validation; preview again");
    cache.delete(key);
    try {
      await call(client, "PUT", "jiraWorkflowXmlDraft", { retry: false, json: { protocol: 1, workflow: args.workflow, xml: xmlText, expectedLiveHash: info.liveHash, expectedDraftHash: info.draftHash } });
    } catch (e) {
      let observation: Record<string, unknown>;
      try {
        const observed = metadata(await call(client, "GET", "jiraWorkflowXml", { params: { protocol: 1, workflow: args.workflow } }), args.workflow);
        observation = { available: true, liveHash: observed.liveHash, draftHash: observed.draftHash, draftNormalizedHash: observed.draftNormalizedHash,
          draftCreatedObserved: info.draftHash === null && observed.draftHash !== null };
      } catch { observation = { available: false, reason: "Read-back unavailable" }; }
      throw new VerificationError("Draft mutation failed or its outcome is indeterminate; reread before a new approved attempt",
        { ...(e instanceof HttpStatusError ? { httpStatus: e.status, ...(errorDetail(e.body) ? { reason: errorDetail(e.body) } : {}) } : {}), observation });
    }
    const after = metadata(await call(client, "GET", "jiraWorkflowXml", { params: { protocol: 1, workflow: args.workflow } }), args.workflow);
    if (after.liveHash !== info.liveHash || after.draftNormalizedHash !== desiredHash) throw new VerificationError("Draft read-back mismatch or live descriptor changed; reread before retry", { liveHash: after.liveHash, draftHash: after.draftHash });
    return { ...common, dry_run: false, result: { verified: true, liveHash: after.liveHash, draftHash: after.draftHash, draftNormalizedHash: after.draftNormalizedHash } };
  },
}];
