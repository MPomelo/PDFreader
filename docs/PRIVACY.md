# Privacy and local data

PDFreader does not include analytics, account login, cloud sync, or an application
backend. PDF rendering, annotations, reading state, translation notes, and cache
are local. WebView2 itself follows Microsoft's runtime behavior and update policy.

A translation action sends the selected text and configured prompt/glossary to
the API endpoint you choose. The application does not upload the entire PDF for
selection translation. Automatic selection translation starts disabled on every
launch; enabling it can cause paid API requests. The provider's privacy policy
and billing apply. Optional model listing and fixed test buttons also contact
that provider when explicitly clicked.

API secrets are stored through native Windows Credential Manager or the explicit
native in-memory session mode. Saved JSON configuration contains no API key, and
the renderer receives only credential status. A secret pasted into the API form
is briefly present in that form before submission, then cleared.

On Windows, application files are under the Roaming AppData directory
`local.pomelo.pdfreader`. `local-v1` contains reading state, notes and cache; the
separate API settings JSON contains endpoint/model preferences. These may contain
document paths and selected text. Clearing translation cache does not delete
notes. Uninstalling the app does not automatically erase this data.

To back up local work, close PDFreader and copy the application data directory.
Back up annotated PDF copies and exported Markdown separately. Credential Manager
keys are not included in that folder backup; re-enter them on another machine.
For a complete manual removal, first export wanted notes, close the app, remove
its local data, and delete its provider keys through Settings before uninstalling.

Do not attach real keys or private PDF content to public issues. Redact endpoint
credentials and use a demo document when reporting a problem.
