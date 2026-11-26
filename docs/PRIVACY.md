# Privacy and local data

PDFreader does not include analytics, cloud sync, or its own application backend.
PDF rendering, annotations, reading state, translation notes, and cache
are local. Markdown and TXT are read and saved on disk. Markdown attachments are
kept next to the document in its `.assets` folder. A network image contacts its
server when you click its load button. WebView2 itself follows Microsoft's runtime behavior and update policy.

A translation action sends the selected text and configured prompt/glossary to
the API endpoint you choose. The application does not upload the entire PDF for
selection translation. Automatic selection translation starts disabled on every
launch; enabling it can cause paid API requests. The provider's privacy policy
and billing apply. Optional model listing and fixed test buttons also contact
that provider when explicitly clicked.

An AI conversation sends the question, reviewed excerpts and earlier completed
turns in the same conversation to the selected model service after
you submit a message. It also sends your configured chat instructions. The
application keeps source paths and file names outside the request payload,
unless you include them in the text. OpenAI requests disable response storage
where supported by the Responses API. Provider privacy and billing terms apply.
The Ollama option connects to the local daemon for downloaded models.

The optional ChatGPT subscription connection opens OpenAI's authorization page
in your system browser. When you authorize plan use, PDFreader requests the
model list and sends eligible chat requests using your ChatGPT account.
Windows Data Protection API protects the connection record and tokens under
Local AppData in `local.pomelo.pdfreader/chatgpt-auth.dat`. Signing out from
AI settings clears the local tokens and attempts to revoke the renewable session.

By default, chat history is saved locally in `local-v1/chat.json` and includes
submitted excerpts, responses and source references. Use a temporary session
for in-memory conversation history, or delete history from the conversation list
and AI settings. Markdown export writes a copy to a path you choose. OpenCode is
disabled while its Windows process isolation remains unverified.

API secrets are stored through native Windows Credential Manager or the explicit
native in-memory session mode. Saved JSON configuration contains no API key, and
the renderer receives only credential status. A secret pasted into the API form
is briefly present in that form before submission, then cleared.

On Windows, application files are under the Roaming AppData directory
`local.pomelo.pdfreader`. `local-v1` contains workspace layout, recent paths, reading state, notes, cache and AI history; the
separate API settings JSON contains endpoint/model preferences. These may contain
document paths and selected text. Clearing translation cache does not delete
notes. Uninstalling the app does not automatically erase this data.

To back up local work, close PDFreader and copy the application data directory.
Back up annotated PDFs, Markdown with its `.assets` folder, and TXT files separately. Credential Manager
keys are not included in that folder backup; re-enter them on another machine.
For a complete manual removal, first export wanted notes, close the app, remove
its local data, and delete its provider keys through Settings before uninstalling.

Do not attach real keys or private PDF content to public issues. Redact endpoint
credentials and use a demo document when reporting a problem.
