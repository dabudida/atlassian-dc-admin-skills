import workflowxml.WorkflowXmlSupport

String xml = '''<workflow><initial-actions><action id="1" name="Create"><results><unconditional-result old-status="Finished" status="Open" step="1"/></results></action></initial-actions><steps><step id="1" name="Open"><meta name="jira.status.id">1</meta><actions><action id="2" name="Loop"><results><unconditional-result old-status="Finished" status="Open" step="1"/></results><post-functions><function type="class"><arg name="class.name">DoNotLoadSentinel</arg><arg name="script">throw new Error('DO-NOT-EXECUTE')</arg></function></post-functions></action></actions></step></steps></workflow>'''
def knownStatus = { String id -> id == '1' }
def knownScreen = { String id -> id == '2' }
def parsed = WorkflowXmlSupport.parse(xml, knownStatus, knownScreen)
assert WorkflowXmlSupport.xml(parsed).contains('DO-NOT-EXECUTE')
assert !WorkflowXmlSupport.xml(parsed).contains('<!DOCTYPE')
assert WorkflowXmlSupport.hash(parsed, true) == WorkflowXmlSupport.hash(WorkflowXmlSupport.parse(WorkflowXmlSupport.xml(parsed), knownStatus, knownScreen), true)
for (String invalid : [
    xml.replace('<post-functions>', '<post-function>').replace('</post-functions>', '</post-function>'),
    '<!DOCTYPE workflow [<!ENTITY x SYSTEM "file:///private/tmp/never-read">]><workflow>&x;</workflow>',
    '<workflow>', xml.replace('jira.status.id">1', 'jira.status.id">999'),
    xml.replace('<action id="2" name="Loop">', '<action id="2" name="Loop"><meta name="jira.fieldscreen.id">999</meta>')
]) {
    boolean rejected = false
    try { WorkflowXmlSupport.parse(invalid, knownStatus, knownScreen) } catch (IllegalArgumentException ignored) { rejected = true }
    assert rejected
}
// Jira writes an empty screen id for transitions without a screen
assert WorkflowXmlSupport.parse(xml.replace('<action id="2" name="Loop">', '<action id="2" name="Loop"><meta name="jira.fieldscreen.id"></meta>'), knownStatus, knownScreen) != null
def audit = WorkflowXmlSupport.parse(xml.replace('<workflow>', '<workflow><meta name="jira.updated.date">today</meta>'), knownStatus, knownScreen)
assert WorkflowXmlSupport.hash(parsed, true) == WorkflowXmlSupport.hash(audit, true)
def changed = WorkflowXmlSupport.parse(xml.replace('DO-NOT-EXECUTE', 'DIFFERENT'), knownStatus, knownScreen)
assert WorkflowXmlSupport.hash(parsed, true) != WorkflowXmlSupport.hash(changed, true)
try {
    WorkflowXmlSupport.parse(xml.replace('id="2"', 'id="PRIVATE-INVALID-ID"'), knownStatus, knownScreen)
    assert false
} catch (IllegalArgumentException e) { assert !e.message.contains('PRIVATE-INVALID-ID') }
println 'Descriptor fixtures PASS; embedded script was not executed'
def draftType = Class.forName('workflowxml.ImportedDraft')
def draft = draftType.declaredConstructors[0].newInstance('Same Workflow', null, parsed)
assert draft.name == 'Same Workflow'
assert draft.draftWorkflow
assert draft.descriptor.is(parsed)
for (String changedXml : [xml.replace('name="Loop"', 'name="Renamed"'), xml.replace('status="Open"', 'status="Different"'), xml.replace('name="Open"', 'name="Different"')]) {
    assert WorkflowXmlSupport.hash(parsed, true) != WorkflowXmlSupport.hash(WorkflowXmlSupport.parse(changedXml, knownStatus, knownScreen), true)
}
boolean oversizedRejected = false
try { WorkflowXmlSupport.parse(' ' * (WorkflowXmlSupport.MAX_BYTES + 1), knownStatus, knownScreen) } catch (IllegalArgumentException ignored) { oversizedRejected = true }
assert oversizedRejected
Class serviceType = Class.forName('workflowxml.WorkflowXmlService')
def live = [name:'Same Workflow', descriptor:parsed, active:true, systemWorkflow:false]
def storedDraft = null
int creates = 0
int saves = 0
boolean allowed = true
boolean failSave = false
boolean ignoreSave = false
def lock = new java.util.concurrent.locks.ReentrantLock()
def service = serviceType.getDeclaredConstructor(Map).newInstance([
    authorize: { allowed }, jiraVersion:'11.3.6', scriptRunnerVersion:'10.11.1',
    workflow: { String name -> name == live.name ? live : null }, draft: { String name -> storedDraft },
    statusExists:knownStatus, screenExists:knownScreen, usage:{ String name -> [total:1, projectIds:['10000']] },
    lock: { String name -> lock }, create: { String name -> creates++; storedDraft = [descriptor:parsed] },
    save: { String name, descriptor -> saves++; if (failSave) throw new RuntimeException('PRIVATE-SAVE-ERROR'); if (!ignoreSave) storedDraft = [descriptor:descriptor] }
])
def metadata = service.read('Same Workflow', 'live', false)
assert metadata.protocol == 1
assert creates == 0 && saves == 0
String edited = xml.replace('DO-NOT-EXECUTE', 'EDITED-SENTINEL')
def validation = service.validate([protocol:1, workflow:'Same Workflow', xml:edited])
assert creates == 0 && saves == 0
def applied = service.apply([protocol:1, workflow:'Same Workflow', xml:edited, expectedLiveHash:metadata.liveHash, expectedDraftHash:null])
assert creates == 1 && saves == 1
assert applied.draftNormalizedHash == validation.desiredNormalizedHash
assert applied.liveHash == metadata.liveHash
assert service.apply([protocol:1, workflow:'Same Workflow', xml:edited, expectedLiveHash:applied.liveHash, expectedDraftHash:applied.draftHash]).alreadySatisfied
assert saves == 1
for (Map invalid : [
    [protocol:1, workflow:'Same Workflow', xml:edited, expectedLiveHash:'stale', expectedDraftHash:applied.draftHash],
    [protocol:2, workflow:'Same Workflow', xml:edited]
]) {
    boolean rejected = false
    try { service.apply(invalid) } catch (Exception ignored) { rejected = true }
    assert rejected
}
allowed = false
boolean rejected = false
try { service.read('Same Workflow', 'live', false) } catch (SecurityException ignored) { rejected = true }
assert rejected && saves == 1
allowed = true
for (String eligibility : ['active', 'systemWorkflow']) {
    live[eligibility] = eligibility == 'systemWorkflow'
    rejected = false
    try { service.validate([protocol:1, workflow:'Same Workflow', xml:edited]) } catch (IllegalArgumentException ignored) { rejected = true }
    assert rejected && saves == 1
    live[eligibility] = eligibility == 'active'
}
storedDraft = null
failSave = true
rejected = false
try { service.apply([protocol:1, workflow:'Same Workflow', xml:edited, expectedLiveHash:metadata.liveHash, expectedDraftHash:null]) }
catch (IllegalStateException e) { rejected = true; assert e.message.contains('draftCreated=true'); assert !e.message.contains('PRIVATE') }
assert rejected && storedDraft != null && creates == 2
failSave = false
ignoreSave = true
Map partial = service.read('Same Workflow')
rejected = false
try { service.apply([protocol:1, workflow:'Same Workflow', xml:edited, expectedLiveHash:partial.liveHash, expectedDraftHash:partial.draftHash]) }
catch (IllegalStateException e) { rejected = true; assert e.message.contains('verification failed') }
assert rejected
ignoreSave = false
storedDraft = null
int savesBeforeConcurrency = saves
def executor = java.util.concurrent.Executors.newFixedThreadPool(2)
def ready = new java.util.concurrent.CountDownLatch(2)
def release = new java.util.concurrent.CountDownLatch(1)
try {
    def futures = (1..2).collect {
        executor.submit({
            ready.countDown(); release.await()
            try { service.apply([protocol:1, workflow:'Same Workflow', xml:edited, expectedLiveHash:metadata.liveHash, expectedDraftHash:null]); return 'saved' }
            catch (IllegalStateException ignored) { return 'stale' }
        } as java.util.concurrent.Callable)
    }
    assert ready.await(5, java.util.concurrent.TimeUnit.SECONDS)
    release.countDown()
    assert futures.collect { it.get(5, java.util.concurrent.TimeUnit.SECONDS) }.sort() == ['saved', 'stale']
    assert saves == savesBeforeConcurrency + 1
} finally { executor.shutdownNow() }
println 'Adapter service fixtures PASS; no live workflow save'
Class endpointType = Class.forName('WorkflowXmlEndpoints')
boolean missingGroupRejected = false
try { endpointType.getDeclaredConstructor().newInstance().run() } catch (IllegalStateException ignored) { missingGroupRejected = true }
assert missingGroupRejected
println 'Endpoint registration guard PASS'

// Rejection messages are adapter-defined and point at the caller's own line numbers.
Closure<String> rejection = { String input ->
    try { WorkflowXmlSupport.parse(input, knownStatus, knownScreen); return null }
    catch (Exception e) { assert e instanceof workflowxml.AdapterRejection : e.class.name; return e.message }
}
String multiline = xml.replace('<steps>', '\n<steps>\n').replace('<post-functions>', '\n<post-functions>')
assert WorkflowXmlSupport.parse(multiline, knownStatus, knownScreen) != null
assert rejection('<?xml version="1.0" encoding="UTF-8"?>\n' + multiline.replace('<post-functions>', '<bogus/><post-functions>')) ==~ /Workflow XML does not match Jira's workflow grammar at line 5, column 9/
assert rejection(multiline.replace('<post-functions>', '<bogus/><post-functions>')) ==~ /Workflow XML does not match Jira's workflow grammar at line 4, column 9/
assert rejection('<workflow>\n<steps>\n</workflow>') ==~ /Invalid XML at line 3, column \d+/
assert rejection('<workflow><bogus/></workflow>') ==~ /Workflow XML does not match Jira's workflow grammar at line 1, column (\d+)/
int grammarColumn = (rejection('<workflow><bogus/></workflow>') =~ /column (\d+)/)[0][1] as int
assert grammarColumn == "<workflow><bogus/>".length() + 1 : "column ${grammarColumn} must exclude the inserted DOCTYPE"
try { service.validate([protocol:1, workflow:'Missing Workflow', xml:edited]); assert false }
catch (workflowxml.AdapterRejection e) { assert e.message == 'Exact workflow not found' }
try { service.apply([protocol:1, workflow:'Same Workflow', xml:edited, expectedLiveHash:'stale', expectedDraftHash:null]); assert false }
catch (workflowxml.AdapterConflict e) { assert e.message == 'Workflow fingerprints changed; preview again' }
println 'Rejection message fixtures PASS'

// Usage is found through the workflow's schemes; the project scan runs only for Jira's default workflow.
def project = { long id -> [getId: { id }] as com.atlassian.jira.project.Project }
def assignable = { long id -> [getId: { id }, isDraft: { false }] as com.atlassian.jira.workflow.AssignableWorkflowScheme }
def draftScheme = [getId: { 12L }, isDraft: { true }] as com.atlassian.jira.workflow.DraftWorkflowScheme
int scans = 0
def byScheme = [10L: [project(30), project(4)], 11L: [project(4)]]
def schemeManager = [
    getSchemesForWorkflowIncludingDrafts: { wf -> [assignable(10), assignable(11), draftScheme] },
    getProjectsUsing: { scheme -> assert !scheme.draft; byScheme[scheme.id] },
    isUsingDefaultScheme: { p -> p.id == 99L },
] as com.atlassian.jira.workflow.WorkflowSchemeManager
def allProjects = { scans++; [project(99), project(4)] }
def custom = [isDefault: { false }] as com.atlassian.jira.workflow.JiraWorkflow
assert workflowxml.WorkflowUsage.usage(custom, schemeManager, allProjects) == [total:2, projectIds:['4', '30']]
assert scans == 0
def defaultWorkflow = [isDefault: { true }] as com.atlassian.jira.workflow.JiraWorkflow
assert workflowxml.WorkflowUsage.usage(defaultWorkflow, schemeManager, allProjects) == [total:3, projectIds:['4', '30', '99']]
assert scans == 1
println 'Workflow usage fixtures PASS'
