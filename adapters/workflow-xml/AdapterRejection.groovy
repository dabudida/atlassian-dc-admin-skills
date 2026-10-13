package workflowxml

/** A rejection whose message is a fixed, content-free reason that the endpoint may return to the caller. */
class AdapterRejection extends IllegalArgumentException {
    AdapterRejection(String message) { super(message) }
}
