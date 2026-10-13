package workflowxml

/** A state conflict whose message is a fixed reason that the endpoint may return to the caller. */
class AdapterConflict extends IllegalStateException {
    AdapterConflict(String message) { super(message) }
}
