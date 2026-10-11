package workflowxml

import com.atlassian.jira.project.Project
import com.atlassian.jira.workflow.AssignableWorkflowScheme
import com.atlassian.jira.workflow.JiraWorkflow
import com.atlassian.jira.workflow.WorkflowScheme
import com.atlassian.jira.workflow.WorkflowSchemeManager
import groovy.transform.CompileStatic

/** Projects using one workflow, found through its schemes rather than a scan of every project. */
@CompileStatic
class WorkflowUsage {
    static Map usage(JiraWorkflow workflow, WorkflowSchemeManager schemes, Closure<Collection<Project>> allProjects) {
        SortedSet<Long> ids = new TreeSet<Long>()
        // draft schemes are not assignable, so no project uses them
        for (WorkflowScheme scheme : schemes.getSchemesForWorkflowIncludingDrafts(workflow)) {
            if (scheme instanceof AssignableWorkflowScheme) for (Project project : schemes.getProjectsUsing((AssignableWorkflowScheme) scheme)) ids.add(project.id)
        }
        // the implicit default scheme has no scheme entity, and only Jira's default workflow is used through it
        if (workflow.isDefault()) {
            for (Project project : allProjects.call()) if (schemes.isUsingDefaultScheme(project)) ids.add(project.id)
        }
        return [total: ids.size(), projectIds: ids.collect { Long id -> id.toString() }]
    }
}
