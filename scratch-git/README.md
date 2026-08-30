# git-palette

Store a Scratch / TurboWarp project in git as an **expanded, diff-friendly tree** instead of an
opaque `.sb3` zip. The `.sb3` is unpacked into `.palette/` + `roles/` by a `pre-commit` hook on
commit, and repacked back into a `.sb3` by `post-checkout` / `post-merge` hooks after the tree
changes. Tool output is stable, English-only text (safe to parse from scripts).

Part of the [scratch-toolchain](https://github.com/palette-community/scratch-toolchain) family;
used together with [scratch-sandbox](https://github.com/palette-community/scratch-sandbox) for
extension block rendering.

English | **[中文](README.zh-CN.md)**

## Table of Contents

- [Installation & Usage](#installation--usage)
- [Managed Repository Layout](#managed-repository-layout)
- [Commands](#commands)
- [Workflow](#workflow)
- [Merge Conflict Handling](#merge-conflict-handling)
- [How It Works (hooks)](#how-it-works-hooks)
- [Extension Dependencies (`.scratchdeps`)](#extension-dependencies-scratchdeps)
- [Development](#development)
- [License](#license)

---

## Installation & Usage

```sh
npm install github:palette-community/git-palette
```

`git-palette` is discovered by git as a subcommand (`git palette <cmd>`). In a project repo:

```sh
git palette init MyProject     # scaffold .palette/, README.md, .scratchdeps, .gitignore
git palette install           # point core.hooksPath at the tool's hooks
git palette commit MyProject.sb3 -m "import v1"   # force-stage the gitignored .sb3
```

After `commit`, the repo stores only the expanded tree; `MyProject.sb3` is gitignored and
regenerated automatically whenever you `git checkout` / `git merge`.

## Managed Repository Layout

```
<repo root>/
├── .palette/
│   ├── type.json            # {"type":"project"}
│   ├── meta.json            # advisory: {name, importedAt, tool, source}
│   ├── project.json         # authoritative project data (pretty-printed, source key order kept)
│   ├── assets.json          # asset index: {"<md5ext>": {target, kind, name}}
│   ├── extensions/          # (optional) parsed extension block-metadata snapshots
│   └── cache/               # locked extension downloads (preserved across rebuilds)
├── roles/
│   ├── stage/               # isStage
│   │   ├── stage.sb         # blocks only (scratchblocks text)
│   │   ├── costumes/*.ext
│   │   └── sounds/*.ext
│   └── <SpriteName>/
│       ├── <SpriteName>.sb # blocks only
│       ├── costumes/*.ext
│       └── sounds/*.ext
├── .scratchdeps             # extension dependency declarations + version locks
└── README.md                # scaffolded by `init`
```

Directory names are English (`roles/`, `stage/`, `costumes/`, `sounds/`); `<SpriteName>` is the
target name from `project.json`, kept verbatim. Each `.sb` file contains **only that target's
blocks** (scratchblocks), with no headings or section labels, ordered by editor `(y, x)` for
stable diffs.

## Commands

| Command | Purpose |
|---|---|
| `git palette install` | Set `core.hooksPath` → tool hooks; ensure `.gitignore` (`/scratch4js/`, `*.sb3`, `node_modules/`) |
| `git palette init [name]` | Scaffold `.palette/`, `README.md`, `.scratchdeps`, and `.gitignore` |
| `git palette import <file.sb3>` | Manually unpack a `.sb3` into the tree (no commit) |
| `git palette export [-o out.sb3]` | Pack the tree back into a `.sb3` (project.json authoritative + assets + extension injection) |
| `git palette commit [sb3...] -m <msg>` | Force-stage the gitignored `.sb3`(s) and commit (pre-commit auto-unpacks) |
| `git palette status` | Compare the working-tree `.sb3` against the committed tree; list differing files |
| `git palette diff [a.sb3 b.sb3]` | No args: `git diff` of the tree; with two `.sb3`: compare their scratchblocks text |
| `git palette conflicts` | List unresolved merge conflicts in the palette tree (tagged text / binary) |
| `git palette resolve <file> [--ours\|--theirs]` | Resolve a binary asset conflict: check out a side and `git add` |
| `git palette editor-sync` | Manually regenerate the editor `.sb3` from the tree (called by post-checkout/post-merge) |
| `git palette deps <list\|lock>` | Inspect / lock extension dependencies |
| `git palette extmeta` | Parse locked extension JS into `.palette/extensions/<id>.json` block-metadata snapshots |

## Workflow

```
external editor (TurboWarp / website)
        │  export MyProject.sb3
        ▼
git palette commit MyProject.sb3
        │  pre-commit hook
        │   from index read blob → unpack → rebuild roles/ + .palette/ → git rm --cached *.sb3 → git add tree
        ▼
git object store = expanded tree (single source of truth)
        │
        ├─ collaborate: git palette diff / status to review block-text changes
        ├─ merge: git palette conflicts / resolve
        │
        └─ checkout / merge → post-checkout / post-merge hook
              git palette editor-sync → regenerate MyProject.sb3 for the editor
external editor reopens MyProject.sb3 → next round
```

The `.sb3` is the "currency" between the editor and the repo — it never enters git (gitignored).
The expanded tree is the only truth stored in git; the two hooks keep the `.sb3` in sync
automatically.

## Merge Conflict Handling

The tree is a mix of human-readable text and binary assets, handled separately:

- **Text conflicts** (`.sb` / `project.json` / `assets.json` / `.scratchdeps`): normal 3-way git
  merge; resolve by editing the scratchblocks text directly. `git palette conflicts` tags these
  `text`. `.palette/meta.json` carries a non-deterministic `importedAt` timestamp and is ignored
  by `status` / comparison.
- **Binary conflicts** (assets `*.svg/*.png/*.wav/...`): git cannot text-merge; `git palette
  conflicts` tags these `binary`. Use `git palette resolve <file> --ours|--theirs` to take one
  side wholesale and `git add` it.
 - **Reverse sync during conflicts**: `post-checkout` / `post-merge` detect unresolved conflicts
   (`git diff --diff-filter=U`) and **skip** regenerating the `.sb3`, so a half-conflicted tree
   never produces a broken `.sb3`.

## Round-trip Fidelity

What you store in git (the `.sb` scratchblocks text + `project.json`) is **functionally
equivalent** to the original `.sb3`, and re-packing produces a `.sb3` that Scratch / TurboWarp
opens without errors. The exact guarantee depends on what your project contains:

| Project shape | Round-trip result |
| --- | --- |
| Vanilla blocks (no custom blocks, no extensions) | **byte-identical** blocks JSON |
| Projects with custom blocks (define + call), variables, lists, broadcasts | blocks JSON **byte-identical**, including original block ids |
| Projects that load extensions whose source is reachable (`.palette/cache/*.js` or a `data:` URL in the project) | extension blocks registered, blocks JSON byte-identical |
| Projects with TurboWarp / PenguinMod bundled extensions | registered, blocks JSON byte-identical |
| Projects with custom extensions whose source is **not** in the project / cache | those extension blocks render as `[unknown opcode: …]` placeholders (lossy for those blocks; safety guard prevents the rest of the project from cascading into corruption) |
| Projects that use advanced Turbowarp features (nested `procedures_call` in expressions, complex custom-block proccodes) | **functionally** equivalent; block **ids** and a few cosmetic form details (input-key strings, genId order) may differ from the source, but the block graph is structurally complete and the `.sb3` opens and runs identically |

If the round-trip detects that too many blocks were lost (e.g. an extension whose source you
didn't bundle), the repack **falls back** to a structure-only rebuild with fresh block ids and
prints a warning — it never produces a broken `.sb3`. See `PLAN.md` in the scratch-toolchain
repo for the full byte-identical report and the small set of edge cases where it can't be
guaranteed (mostly: dynamic argId keys in custom-block call inputs and projects that bundle
custom extensions without their source).

## How It Works (hooks)

- `pre-commit`: find staged `*.sb3` → read each blob from the **index** (not the working tree) →
  unpack to the tree at the repo root → `git rm --cached` the `.sb3` and `git add` the tree. Idempotent.
- `post-checkout` / `post-merge`: run `editor-sync` → rebuild the gitignored `.sb3` from the tree
  (skipped when unresolved conflicts exist).

## Extension Dependencies (`.scratchdeps`)

```ini
# dependency declarations (extension version locking)
pen: builtin
myext: https://ext.turbowarp.org/foo.js
  sha256: ab12…
```

- `unpack` extracts from `project.json.extensions`: string → builtin; object (`extensionId`/`js`) → custom.
- `export` writes them back: builtin → string; custom → `{extensionId, js, type:'extension'}`.
- `deps lock` downloads custom extension JS into `.palette/cache/<id>.js` and records its sha256.

## Development

```sh
npm test            # node --test test/*.test.js
```

Round-trip, conflict, and git-flow integration tests run against temporary git repos.

## License

MPL-2.0.
