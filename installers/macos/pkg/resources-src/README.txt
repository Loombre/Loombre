Authoring sources for the Installer panes (welcome/readme/conclusion).
The committed .rtf files in ../resources are GENERATED from these HTML
files — edit the HTML, then regenerate with:

  textutil -convert rtf welcome.html -output ../resources/welcome.rtf
  (same for readme.html / conclusion.html)

One paragraph = one <p> — never hard-wrap prose; macOS Installer re-wraps
to its pane width, which is exactly the W17 bug (ragged mid-sentence
breaks) this structure fixed. The charset meta tag is REQUIRED: without
it textutil reads UTF-8 as Latin-1 and em dashes ship as mojibake.
