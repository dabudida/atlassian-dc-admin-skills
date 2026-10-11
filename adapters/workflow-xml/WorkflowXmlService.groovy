package workflowxml

/** Jira dependencies are supplied by the endpoint wrapper; fixtures use inert descriptor stores. */
class WorkflowXmlService {
    private final Map dependencies
    WorkflowXmlService(Map dependencies) { this.dependencies = dependencies }

    private void authorize() {
        if (!dependencies.authorize.call()) throw new SecurityException('Jira administrator permission required')
        if (!(dependencies.jiraVersion ==~ /11\.3\..+/) || !(dependencies.scriptRunnerVersion ==~ /10\..+/)) {
            throw new UnsupportedOperationException('Unsupported Jira/ScriptRunner pair')
        }
    }
    private void payload(Map input) {
        authorize()
        if (input.protocol != 1 || !(input.workflow instanceof String) || !input.workflow || input.workflow.length() > 255 || !(input.xml instanceof String)) {
            throw new AdapterRejection('Invalid adapter protocol or request identity')
        }
    }
    private def workflow(String name) {
        def live = dependencies.workflow.call(name)
        if (live == null || live.name != name) throw new AdapterRejection('Exact workflow not found')
        return live
    }
    private void eligible(def live) {
        if (!live.active || live.systemWorkflow) throw new AdapterRejection('Only an active non-system workflow can receive a draft')
    }
    private def descriptor(String xml) { WorkflowXmlSupport.parse(xml, dependencies.statusExists, dependencies.screenExists) }

    Map read(String name, String mode = 'live', boolean includeXml = false) {
        authorize()
        if (!name || name.length() > 255 || !(mode in ['live', 'draft'])) throw new AdapterRejection('Invalid workflow selection')
        def live = workflow(name)
        def draft = dependencies.draft.call(name)
        def chosen = mode == 'draft' ? draft : live
        if (chosen == null && includeXml) throw new AdapterRejection('Requested draft does not exist')
        Map usage = dependencies.usage.call(name)
        Map result = [protocol:1, jiraVersion:dependencies.jiraVersion, scriptRunnerVersion:dependencies.scriptRunnerVersion,
            workflow:name, active:live.active, system:live.systemWorkflow,
            liveHash:WorkflowXmlSupport.hash(live.descriptor), draftHash:draft == null ? null : WorkflowXmlSupport.hash(draft.descriptor),
            draftNormalizedHash:draft == null ? null : WorkflowXmlSupport.hash(draft.descriptor, true),
            usage:[total:usage.total, projectIds:(usage.projectIds ?: []).take(100), truncated:(usage.projectIds ?: []).size() > 100]]
        if (includeXml) {
            String xml = WorkflowXmlSupport.xml(chosen.descriptor)
            if (xml.getBytes('UTF-8').length > WorkflowXmlSupport.MAX_BYTES) throw new AdapterRejection('Workflow XML exceeds byte limit')
            result.xml = xml
            result.mode = mode
            result.counts = [steps:chosen.descriptor.steps.size(), initialActions:chosen.descriptor.initialActions.size(), globalActions:chosen.descriptor.globalActions.size()]
        }
        return result
    }
    Map validate(Map input) {
        payload(input)
        def live = workflow(input.workflow)
        eligible(live)
        def desired = descriptor(input.xml)
        return read(input.workflow) + [desiredNormalizedHash:WorkflowXmlSupport.hash(desired, true)]
    }
    Map apply(Map input) {
        payload(input)
        def lock = dependencies.lock.call('workflow-xml-' + WorkflowXmlSupport.sha(input.workflow))
        lock.lock()
        try {
            def live = workflow(input.workflow)
            eligible(live)
            Map before = read(input.workflow)
            if (!input.containsKey('expectedDraftHash') || before.liveHash != input.expectedLiveHash || before.draftHash != input.expectedDraftHash) {
                throw new AdapterConflict('Workflow fingerprints changed; preview again')
            }
            def desired = descriptor(input.xml)
            String hash = WorkflowXmlSupport.hash(desired, true)
            if (before.draftNormalizedHash == hash) return before + [alreadySatisfied:true]
            boolean created = false
            try {
                if (before.draftHash == null) { dependencies.create.call(input.workflow); created = true }
                dependencies.save.call(input.workflow, desired)
            } catch (Exception ignored) {
                throw new AdapterConflict("Draft persistence failed; draftCreated=${created}; reread before retry")
            }
            Map after = read(input.workflow)
            if (after.liveHash != before.liveHash || after.draftNormalizedHash != hash) {
                throw new AdapterConflict('Draft verification failed; reread before retry')
            }
            return after + [alreadySatisfied:false, draftCreated:created]
        } finally { lock.unlock() }
    }
}
