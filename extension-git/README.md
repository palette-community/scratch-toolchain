# extension-git

The extension half of the [scratch-toolchain](https://github.com/palette-community/scratch-toolchain)
collaboration workflow. Owns everything about Scratch **extensions** (custom + built-in)
so the vanilla half ([`scratch-git`](../scratch-git)) can stay focused on the core
workflow and simply depend on this package for extension parsing and registration.

`scratch-git` calls this package on every `.sb3` ↔ tree conversion: it reads the project
record, fetches (or inlines) each extension's source, and registers the resulting block
definitions with the I/O-free `parse-sb3-blocks` parser so the forward / reverse round-trip
emits valid scratchblocks text.

English | **[中文](README.zh-CN.md)**

## Table of Contents

- [What It Does](#what-it-does)
- [Public API](#public-api)
- [Source Layout](#source-layout)
- [Extension Sources](#extension-sources)
- [Cache Layout (`.palette/cache`)](#cache-layout-palettecache)
- [Development](#development)
- [License](#license)

---

## What It Does

A Scratch / TurboWarp `.sb3` records its extensions in two places:

- `project.extensionURLs` — an object mapping each extension id to its source location
  (`https://…js` URL or inline `data:` URL).
- `project.extensions` — a bare-id list (BOTH built-in and custom). An id present here
  but absent from `extensionURLs` is a built-in / unresolved extension; we keep its
  `builtin` classification and the parser renders it as an `[unknown opcode: …]`
  placeholder (the safety guard in `scratch-git` prevents the rest of the project from
  cascading into corruption).

This package turns those records into registered block definitions. Concretely:

1. `resolveExtensions(project, { paletteDir })` — walks `project.extensionURLs` + bare
   `project.extensions` URL entries; for each:
   - `data:` URL → inline decode (`base64` or percent-encoded).
   - `https://` URL → write to `.palette/cache/<id>.js` (if not already there) and
     `registerExtensionFromSource` it.
   - bare id in `extensions` with no URL → left for `registerTurbowarpBuiltins` to handle
     (or `[unknown opcode: …]` if not built in).
2. `registerCachedExtensions(paletteDir)` — re-loads already-cached extension JS from
   `.palette/cache/*.js` so offline / repeated runs work without network.
3. `registerTurbowarpBuiltins()` — loads the bundled TurboWarp `scratch-vm` extension
   submodule (`extensions/turbowarp/src/extensions/`) and registers the canonical
   `pen`, `music`, `videoSensing`, … blocks.

`scratch-git` invokes all three during unpack (pre-commit) and pack (post-checkout /
post-merge), before the `parse-sb3-blocks` forward / reverse renderer runs.

## Public API

The package's `main` (`src/index.js`) re-exports three functions:

| Function | Purpose |
|---|---|
| `resolveExtensions(project, { paletteDir })` | Resolve a project's `extensionURLs` + `extensions` into registered block definitions. Writes fetched sources to `paletteDir/cache/`. |
| `registerCachedExtensions(paletteDir)` | Re-register every `*.js` already in `paletteDir/cache/` (offline / idempotent). |
| `registerTurbowarpBuiltins()` | Register TurboWarp's built-in extensions (loaded from the `extensions/turbowarp` git submodule). |

Typical call order (see `scratch-git/src/repack.js` and `hook.js`):

```js
import {
    resolveExtensions,
    registerCachedExtensions,
    registerTurbowarpBuiltins,
} from 'extension-git';

registerTurbowarpBuiltins();
await resolveExtensions(project, { paletteDir });
// or, for a fully offline / reproducible run:
registerCachedExtensions(paletteDir);
```

The two registered sources compose: a `pen` block (built-in) and a custom
`myext_*` block (from `data:` URL) both end up in `parse-sb3-blocks`'s global block
tables so the forward renderer emits them and the reverse parser recognises them.

## Source Layout

```
extension-git/
├── package.json
└── src/
    ├── index.js         # public API re-exports
    ├── extresolve.js    # resolveExtensions + registerCachedExtensions + data: URL decoder
    └── builtins.js      # registerTurbowarpBuiltins (reads the extensions/turbowarp submodule)
```

No other runtime dependencies beyond `parse-sb3-blocks` (for block registration) and
`scratch-sandbox` (for evaluating custom extension source in a constrained CommonJS
shim).

## Extension Sources

The decoder handles both wire formats:

| Form | Example | Decoded by |
|---|---|---|
| `data:application/javascript;base64,…` | inline, base64 | `Buffer.from(payload, 'base64').toString('utf8')` |
| `data:application/javascript,…` (percent-encoded) | inline, percent-encoded | `decodeURIComponent(payload)` |
| `data:text/javascript;base64,…` / `data:text/javascript,…` | same as above with the other MIME type | as above |
| `https://…/ext.js` | downloaded at resolve time | `opts.fetch(url)` injected by the caller |

`scratch-git` passes a `fetch` option (with a timeout) to `resolveExtensions` for the
`https://` case; on failure the extension stays unregistered and the block graph
emits the standard `[unknown opcode: …]` placeholder.

## Cache Layout (`.palette/cache`)

When `resolveExtensions` downloads a custom extension, it writes:

```
.palette/cache/
├── <ext-id>.js           # locked source (sha256-verified if .scratchdeps records one)
└── <ext-id>.json         # parsed getInfo() snapshot (block metadata, menus, icons)
```

Both files are gitignored at the project level (they're reproducible from
`extensionURLs` + `.scratchdeps`). `registerCachedExtensions` re-loads the `.js` files
without contacting the network, so a fresh clone with a populated cache round-trips
without re-downloading.

## Development

```sh
npm test            # node --test test/*.test.js
```

The test suite covers `data:` URL decoding (base64 / percent-encoded, with and without
`charset` meta, both MIME types).

Development against the live `parse-sb3-blocks` source (sibling repo) — see
[`scratch-git` README](../scratch-git#development) for the symlink dance; the same
applies here.

## License

MPL-2.0.
