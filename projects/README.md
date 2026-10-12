# projects/

Empty on purpose. Open the editor and click **New Project** — the Wizard scaffolds a
project here (`<slug>.ae1proj` + `<slug>/{scenes,scripts,media}`).

AE1 ships **no game assets**. Bring your own, or generate original ones with the
forges in the repo root: `meshforge.py` (props from English), `clipforge.py`
(mechanical animation from English), `audioforge.py` (speech). Per-project media
blobs are git-ignored by content hash; only `manifest.json` is tracked.
