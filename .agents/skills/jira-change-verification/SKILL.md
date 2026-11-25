

For ScriptRunner binding changes, also verify the configuration slot rather than only the feature name:

- inspect Behaviour Initialisers and field-level scripts separately;
- treat each field, validator, condition, post-function, and Initialiser as an independent slot;
- verify the actual Inline/File mode and scriptPath after reloading the Jira page;
- do not interpret scriptPath=null without checking the feature schema: Database Picker and other non-Groovy configuration may use the same shape;
- compare the original Inline source and the server ScriptRoot file by SHA-256 when the change is intended to be verbatim;
- take a new snapshot after the change before counting remaining Inline slots;
- keep refactoring, bug fixes, renaming, and script universalisation outside a verbatim migration;
- record rollback data for the original source, mapping, method, enabled state, and binding.
