package workflowxml

import com.opensymphony.workflow.loader.WorkflowDescriptor
import com.atlassian.jira.workflow.JiraWorkflow
import org.w3c.dom.Element
import org.xml.sax.ErrorHandler
import org.xml.sax.InputSource
import org.xml.sax.SAXParseException
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/** Parse descriptor data only. Never evaluate rule classes, scripts or XML entities. */
class WorkflowXmlSupport {
    static final int MAX_BYTES = 20 * 1024 * 1024
    private static final String TRUSTED_DOCTYPE = '<!DOCTYPE workflow SYSTEM "urn:workflowxml:trusted-grammar">'

    static WorkflowDescriptor parse(String input, Closure<Boolean> statusExists, Closure<Boolean> screenExists) {
        if (input == null || input.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
            throw new XmlInputRejected('Workflow XML exceeds byte limit')
        }
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance()
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
            factory.setFeature('http://apache.org/xml/features/disallow-doctype-decl', true)
            factory.setFeature('http://xml.org/sax/features/external-general-entities', false)
            factory.setFeature('http://xml.org/sax/features/external-parameter-entities', false)
            factory.setFeature('http://apache.org/xml/features/nonvalidating/load-external-dtd', false)
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, '')
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, '')
            factory.setXIncludeAware(false)
            factory.setExpandEntityReferences(false)
            def builder = factory.newDocumentBuilder()
            builder.setEntityResolver { String publicId, String systemId -> throw new XmlInputRejected('External XML resolution refused') }
            builder.setErrorHandler(new ErrorHandler() {
                void warning(SAXParseException e) { throw e }
                void error(SAXParseException e) { throw e }
                void fatalError(SAXParseException e) { throw e }
            })
            Element root = builder.parse(new InputSource(new StringReader(input))).documentElement
            if (root.tagName != 'workflow') throw new XmlInputRejected('Expected workflow root')
            validateSource(input)
            def metas = root.getElementsByTagName('meta')
            for (int i = 0; i < metas.length; i++) {
                Element meta = (Element) metas.item(i)
                String key = meta.getAttribute('name')
                String id = meta.textContent.trim()
                if (key == 'jira.status.id' && !statusExists.call(id)) throw new XmlInputRejected('Unknown workflow status reference')
                if (key == 'jira.fieldscreen.id' && (!id.matches('[0-9]+') || !screenExists.call(id))) throw new XmlInputRejected('Unknown workflow screen reference')
            }
            WorkflowDescriptor descriptor = new WorkflowDescriptor(root)
            descriptor.validate()
            return descriptor
        } catch (SAXParseException e) {
            throw new XmlInputRejected("Invalid XML at line ${e.lineNumber}, column ${e.columnNumber}")
        } catch (XmlInputRejected e) {
            throw e
        } catch (Exception ignored) {
            throw new XmlInputRejected('Invalid workflow descriptor or unavailable secure parser')
        }
    }

    /**
     * Validate source grammar against Jira's bundled DTD before OSWorkflow can discard unknown nodes.
     * The caller has already parsed the input without a DOCTYPE, so the trusted DOCTYPE is inserted
     * in place: line numbers of grammar errors then match the caller's file.
     */
    private static void validateSource(String input) {
        def declaration = input =~ /\A\uFEFF?<\?xml[^>]*\?>/
        int at = declaration.find() ? declaration.end() : (input.startsWith('\uFEFF') ? 1 : 0)
        byte[] trustedDtd
        def stream = WorkflowDescriptor.getResourceAsStream('/META-INF/workflow_2_8.dtd')
        if (stream == null) throw new XmlInputRejected('Bundled workflow grammar unavailable')
        try { trustedDtd = stream.bytes } finally { stream.close() }
        def factory = DocumentBuilderFactory.newInstance()
        factory.setValidating(true)
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
        factory.setFeature('http://xml.org/sax/features/external-general-entities', false)
        factory.setFeature('http://xml.org/sax/features/external-parameter-entities', false)
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, '')
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, '')
        factory.setXIncludeAware(false)
        factory.setExpandEntityReferences(false)
        def validator = factory.newDocumentBuilder()
        validator.setEntityResolver { String publicId, String systemId ->
            if (systemId != 'urn:workflowxml:trusted-grammar') throw new XmlInputRejected('External XML resolution refused')
            new InputSource(new ByteArrayInputStream(trustedDtd))
        }
        validator.setErrorHandler(new ErrorHandler() {
            void warning(SAXParseException e) { throw e }
            void error(SAXParseException e) { throw e }
            void fatalError(SAXParseException e) { throw e }
        })
        try {
            validator.parse(new InputSource(new StringReader(input.substring(0, at) + TRUSTED_DOCTYPE + input.substring(at))))
        } catch (SAXParseException e) {
            // only the first line carries the inserted DOCTYPE
            int column = e.lineNumber == 1 && e.columnNumber > at + TRUSTED_DOCTYPE.length() ? e.columnNumber - TRUSTED_DOCTYPE.length() : e.columnNumber
            throw new XmlInputRejected("Workflow XML does not match Jira's workflow grammar at line ${e.lineNumber}, column ${column}")
        }
    }

    static String xml(WorkflowDescriptor descriptor) {
        StringWriter output = new StringWriter()
        PrintWriter writer = new PrintWriter(output)
        descriptor.writeXML(writer, 0)
        writer.flush()
        return '<?xml version="1.0" encoding="UTF-8"?>\n' + output.toString()
    }

    static String sha(String value) {
        MessageDigest.getInstance('SHA-256').digest(value.getBytes(StandardCharsets.UTF_8)).encodeHex().toString()
    }

    /** Only root audit metadata is omitted; all functional descriptor data is preserved. */
    static String hash(WorkflowDescriptor descriptor, boolean functional = false) {
        if (!functional) return sha(xml(descriptor))
        WorkflowDescriptor copy = parse(xml(descriptor), { true }, { true })
        [JiraWorkflow.JIRA_META_UPDATE_AUTHOR_NAME, JiraWorkflow.JIRA_META_UPDATE_AUTHOR_KEY, JiraWorkflow.JIRA_META_UPDATED_DATE].each { copy.metaAttributes.remove(it) }
        return sha(xml(copy))
    }
}

/** A rejection whose message is a fixed, content-free reason that the endpoint may return to the caller. */
class AdapterRejection extends IllegalArgumentException {
    AdapterRejection(String message) { super(message) }
}

/** Rejected workflow XML input; the message never quotes the input. */
class XmlInputRejected extends AdapterRejection {
    XmlInputRejected(String message) { super(message) }
}

/** A state conflict whose message is a fixed reason that the endpoint may return to the caller. */
class AdapterConflict extends IllegalStateException {
    AdapterConflict(String message) { super(message) }
}
