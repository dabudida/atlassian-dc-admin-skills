package workflowxml

import com.atlassian.jira.workflow.JiraDraftWorkflow
import com.atlassian.jira.workflow.WorkflowManager
import com.opensymphony.workflow.loader.WorkflowDescriptor
import groovy.transform.CompileStatic

/** Carry an already validated replacement descriptor through Jira's draft API. */
@CompileStatic
class ImportedDraft extends JiraDraftWorkflow {
    ImportedDraft(String name, WorkflowManager manager, WorkflowDescriptor descriptor) {
        super(name, manager, descriptor)
    }
}
