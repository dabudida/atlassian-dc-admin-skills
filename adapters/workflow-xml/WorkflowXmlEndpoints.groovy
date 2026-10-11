import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate
import com.atlassian.jira.component.ComponentAccessor
import com.atlassian.jira.permission.GlobalPermissionKey
import com.atlassian.jira.security.GlobalPermissionManager
import com.atlassian.jira.issue.fields.screen.FieldScreenManager
import com.atlassian.jira.util.BuildUtilsInfo
import com.atlassian.beehive.ClusterLockService
import groovy.transform.BaseScript
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import jakarta.ws.rs.core.MultivaluedMap
import jakarta.ws.rs.core.Response
import workflowxml.AdapterConflict
import workflowxml.AdapterRejection
import workflowxml.ImportedDraft
import workflowxml.WorkflowUsage
import workflowxml.WorkflowXmlService

@BaseScript CustomEndpointDelegate delegate

// Set an existing administrator group before separately deploying this endpoint.
final String adminGroup = ''
if (!adminGroup.trim()) throw new IllegalStateException('Configure an existing administrator registration group before deployment')

Closure service = {
    def user = ComponentAccessor.jiraAuthenticationContext.loggedInUser
    def permissions = ComponentAccessor.getComponent(GlobalPermissionManager)
    def manager = ComponentAccessor.workflowManager
    def screens = ComponentAccessor.getComponent(FieldScreenManager)
    def locks = ComponentAccessor.getComponent(ClusterLockService)
    def plugin = ComponentAccessor.pluginAccessor.getPlugin('com.onresolve.jira.groovy.groovyrunner')
    new WorkflowXmlService([
        authorize:{ user != null && permissions.hasPermission(GlobalPermissionKey.ADMINISTER, user) },
        jiraVersion:ComponentAccessor.getComponent(BuildUtilsInfo).version,
        scriptRunnerVersion:plugin?.pluginInformation?.version ?: '',
        workflow:{ String name -> manager.getWorkflow(name) }, draft:{ String name -> manager.getDraftWorkflow(name) },
        statusExists:{ String id -> ComponentAccessor.constantsManager.getStatus(id) != null },
        screenExists:{ String id -> screens.getFieldScreen(Long.valueOf(id)) != null },
        usage:{ String name -> WorkflowUsage.usage(manager.getWorkflow(name), ComponentAccessor.workflowSchemeManager, { ComponentAccessor.projectManager.projectObjects }) },
        lock:{ String key -> locks.getLockForName(key) },
        create:{ String name -> manager.createDraftWorkflow(user, name) },
        save:{ String name, descriptor -> manager.updateWorkflow(user, new ImportedDraft(name, manager, descriptor)) }
    ])
}
Closure reply = { Closure operation ->
    try { Response.ok(JsonOutput.toJson(operation.call())).type('application/json').build() }
    catch (SecurityException ignored) { Response.status(403).entity('{"error":"Administrator permission required"}').type('application/json').build() }
    catch (UnsupportedOperationException ignored) { Response.status(501).entity('{"error":"Unsupported adapter pair"}').type('application/json').build() }
    // only adapter-defined rejections carry fixed, content-free messages; anything else stays generic
    catch (AdapterRejection e) { Response.status(400).entity(JsonOutput.toJson([error:e.message])).type('application/json').build() }
    catch (IllegalArgumentException ignored) { Response.status(400).entity('{"error":"Invalid workflow request or descriptor"}').type('application/json').build() }
    catch (AdapterConflict e) { Response.status(409).entity(JsonOutput.toJson([error:e.message])).type('application/json').build() }
    catch (IllegalStateException ignored) { Response.status(409).entity('{"error":"Workflow state conflict; reread before retry"}').type('application/json').build() }
    catch (Exception ignored) { Response.status(500).entity('{"error":"Adapter operation failed; reread before retry"}').type('application/json').build() }
}
Closure payload = { String body ->
    if (body == null || body.getBytes('UTF-8').length > 22 * 1024 * 1024) throw new AdapterRejection('Request exceeds byte limit')
    def parsed = new JsonSlurper().parseText(body)
    if (!(parsed instanceof Map)) throw new AdapterRejection('Expected object')
    parsed
}

jiraWorkflowXml(httpMethod:'GET', groups:[adminGroup]) { MultivaluedMap query ->
    reply {
        if (query.getFirst('protocol') != '1') throw new AdapterRejection('Invalid protocol')
        service().read(query.getFirst('workflow') as String, (query.getFirst('mode') ?: 'live') as String, query.getFirst('include_xml') == 'true')
    }
}
jiraWorkflowXmlValidate(httpMethod:'POST', groups:[adminGroup]) { MultivaluedMap query, String body ->
    reply { service().validate(payload(body)) }
}
jiraWorkflowXmlDraft(httpMethod:'PUT', groups:[adminGroup]) { MultivaluedMap query, String body ->
    reply { service().apply(payload(body)) }
}
