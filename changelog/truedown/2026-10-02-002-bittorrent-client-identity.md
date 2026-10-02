# BitTorrent client identity settings

- Added BT User-Agent and Peer ID prefix controls under Engine and modules for
  Aria2 Next 2.6.7+, covering imported torrents, torrent URLs and magnet tasks.
- Persist and apply both global options immediately, restore them at startup,
  and reset blank values to the reviewed NEXT defaults. HTTP User-Agent remains
  independent; stable and older NEXT engines do not receive unsupported options.
- Corrected the obsolete fixed-identity description and startup diagnostic.
- Added migration, validation, partial-update, UI draft-preservation and real
  NEXT RPC integration coverage.

## Verification

- Focused Go and JavaScript regression tests; full Go tests and `go vet`.
- Pinned NEXT 2.8.3 acceptance, including actual global-option readback after
  startup, hot updates, restart and default restoration.
- Browser fixture checks use the production UI with an isolated API fixture;
  they do not establish remote tracker acceptance or peer handshake behavior.
