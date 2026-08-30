# scratch-toolchain

Collaborate on Scratch / TurboWarp projects through git. The `.sb3` zip is unpacked into an
expanded, diff-friendly tree on commit, and repacked back into a `.sb3` after checkout / merge
so the editor stays in sync. The tree is the single source of truth in git; the `.sb3` is
gitignored and regenerated automatically.

English | **[中文](README.zh-CN.md)**

## Packages

This repository is a small monorepo with two packages:

| Package | Role | README |
|---|---|---|
| [`scratch-git/`](./scratch-git) | The vanilla-Scratch workflow: CLI (`git palette`), git hooks, `.sb3` ↔ tree conversion, conflict handling. Owns the user-facing surface. | [README](./scratch-git/README.md) |
| [`extension-git/`](./extension-git) | Extension discovery, resolution and registration (custom + built-in TurboWarp extensions). Owned by `scratch-git` as a dependency. | [README](./extension-git/README.md) |

External dependencies (consumed by both packages, not vendored):

- [`parse-sb3-blocks`](https://github.com/palette-community/parse-sb3-blocks) — I/O-free
  scratchblocks parser / serializer. The `scratch-git` package must be developed against its
  source tree (see *Development* in `scratch-git/README.md`).
- [`scratch-sandbox`](https://github.com/palette-community/scratch-sandbox) — CommonJS shim
  for evaluating custom extension `getInfo()` source safely.
- `extensions/turbowarp/` (git submodule) — sparse checkout of TurboWarp's
  [`scratch-vm`](https://github.com/TurboWarp/scratch-vm) for the canonical built-in extension
  block metadata (`pen`, `music`, …).

## What You Get

```
┌─────────────────────────────────┐
│  external editor (TurboWarp)     │
│  MyProject.sb3  ←→  MyProject.sb3│
└────────────────┬────────────────┘
                 │ git palette commit / editor-sync
┌────────────────▼────────────────┐
│  scratch-git  ──depends on──►   │
│  (CLI, hooks, .sb3↔tree)   extension-git   │
│                    (resolve / register)   │
└────────────────┬────────────────┘
                 │
┌────────────────▼────────────────┐
│  expanded tree in git            │
│  .palette/  roles/  .scratchdeps │
└─────────────────────────────────┘
```

A typical round:

1. In the editor: `Export` → `MyProject.sb3`.
2. `git palette commit MyProject.sb3 -m "import v1"` — pre-commit hook unpacks the `.sb3`
   into `.palette/` + `roles/`, removes the staged `.sb3`, and commits the tree.
3. Collaborate: review the diff in scratchblocks text (`.sb` files) and JSON
   (`project.json`), merge, resolve conflicts.
4. `git checkout` / `git merge` — post-checkout / post-merge hook regenerates `MyProject.sb3`
   from the tree (skipped if conflicts are unresolved).
5. Reopen `MyProject.sb3` in the editor. Repeat.

## Round-trip Fidelity

The expansion ↔ repack cycle is **functionally equivalent** for any project Scratch /
TurboWarp can open. For most projects (vanilla blocks, custom blocks, bundled
extensions, reachable custom-extension sources) it is also **byte-identical** at the
blocks-JSON level. See the full table in
[`scratch-git/README.md`](./scratch-git#round-trip-fidelity).

A safety guard in `scratch-git` ensures the repack **never produces a broken `.sb3`**:
if too many blocks are lost (e.g. an extension whose source you didn't bundle), the
repack falls back to a structure-only rebuild with fresh block ids and prints a warning.

## Install / Use

Install the CLI once:

```sh
npm install github:palette-community/scratch-toolchain#packages/scratch-git
```

Then, in a Scratch / TurboWarp project repo:

```sh
git palette init MyProject
git palette install
git palette commit MyProject.sb3 -m "import v1"
```

See [`scratch-git/README.md`](./scratch-git) for the full command list, layout, and
workflow.

## Layout

```
scratch-toolchain/
├── README.md                 # this file
├── scratch-git/              # vanilla workflow package (CLI, hooks, parser glue)
├── extension-git/            # extension discovery/registration package
├── extensions/turbowarp/     # git submodule: sparse TurboWarp scratch-vm extensions
└── test_sb3/                 # local test fixtures (not part of any package)
```

## Development

Each package has its own `npm test` and `README`. For a typical setup:

```sh
# scratch-git: develop against the live parse-sb3-blocks source
cd scratch-git
rm -rf node_modules/parse-sb3-blocks
ln -s ../../parse-sb3-blocks node_modules/parse-sb3-blocks   # adjust path as needed
npm install --no-audit --no-fund
npm test
```

`npm install` replaces the symlink with the published tarball; recreate it after every
install. `extension-git` uses the same pattern for its `parse-sb3-blocks` and
`scratch-sandbox` symlinks (used as transitive deps via the workspace `scratch-git`).

## License

MPL-2.0.
