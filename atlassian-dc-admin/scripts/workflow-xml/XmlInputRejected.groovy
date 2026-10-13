package workflowxml

/** Rejected workflow XML input; the message never quotes the input. */
class XmlInputRejected extends AdapterRejection {
    XmlInputRejected(String message) { super(message) }
}
