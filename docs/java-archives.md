# Java archives and class files

Three tools cover JVM bytecode in a local JAR (or another ZIP-backed JVM
archive such as a WAR/EAR) or a single `.class` file. They are independent of
the APK/DEX lane: use the [Android tools](android-analysis.md) for APKs.

| Tool                                            | Answers                                                          | Requires                                    |
| ----------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| `inspect_java_archive` / `inspect-java-archive` | What is in this archive and where is the interesting code?       | Nothing beyond REA                          |
| `inspect_java_class` / `inspect-java-class`     | What does this one class declare and which literals does it use? | Nothing beyond REA                          |
| `decompile_java_class` / `decompile-java-class` | What does this class's code look like as Java source?            | Caller-supplied Vineflower JAR and Java 17+ |

The first two use REA's bundled TypeScript class-file reader. They never load,
verify or run target bytecode, start no process, write no file and need no
Java installation or active binary target.

```bash
rea inspect-java-archive /absolute/path/to/mod.jar --json
rea inspect-java-archive /absolute/path/to/mod.jar --query com/example/net/ --limit 50 --json
rea inspect-java-class /absolute/path/to/mod.jar com.example.Main --json
REA_VINEFLOWER_JAR=/opt/vineflower/vineflower.jar \
  rea decompile-java-class /absolute/path/to/mod.jar com.example.Main --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires absolute paths. Class names accept dotted (`com.example.Main`) or slash
(`com/example/Main$Inner`) binary form. For a JAR, `class_name` is required; for
a single `.class` file it may be omitted and, when given, must match the class
the file declares.

## Archive inventory

`inspect_java_archive` classifies the selected bytes by content: `0xCAFEBABE`
with a class-file major version of at least 45 is a class file, and a ZIP
signature is an archive. A universal Mach-O header shares the magic but carries
a small slice count where the version would be, and is reported as unsupported.
The Evidence subject format is `zip` for archives and `file` for class files;
`artifact.container` is `jar` or `class`.

The result contains:

- `manifest`: the main section of `META-INF/MANIFEST.MF`, with continuation
  lines joined, and `main_class`. Per-entry sections, such as signed-JAR
  digests, are not reported.
- `metadata_files`: framework descriptors found at their exact paths — Forge
  `mcmod.info` and `META-INF/mods.toml` (also NeoForge), Fabric
  `fabric.mod.json`, Quilt `quilt.mod.json`, Bukkit/Paper `plugin.yml`, BungeeCord
  `bungee.yml`, `velocity-plugin.json`, Spring Boot `BOOT-INF/layers.idx` and
  `META-INF/services/*`. Text is returned as found up to 64 KiB with
  `truncated`; non-UTF-8 text is `null` rather than guessed.
- `entries`: counts plus native libraries (`.so`, `.dll`, `.dylib`, `.jnilib`),
  nested archives and signature files.
- `bytecode_versions`, and `packages` with each package's class count and how
  many class names are two characters or shorter.
- `classes`: a page of class rows sorted by binary name. `query` is a
  case-sensitive substring of binary names (dots are treated as slashes); follow
  `next_offset` until it is `null`. `total_matching` counts the whole filtered
  set.
- `malformed_classes`: every class entry that failed to parse, with the reason.
  Parsing failures of individual classes do not fail the inventory.
- `name_obfuscation`: a labeled heuristic. `assessment` is `likely` when at least
  half of the class names or field/method names are two characters or shorter,
  `insufficient-data` below five classes and twenty members, and otherwise
  `not-indicated`. It is not proof of obfuscation or of a particular obfuscator,
  and says nothing about string encryption or control-flow protection. Compare
  per-package `short_name_classes` to separate renamed application code from
  bundled libraries.

## One class

`inspect_java_class` reports access flags, super class, interfaces, generic
`Signature`s, class/field/method annotations with element values, fields with
JVM descriptors and `ConstantValue` literals, and methods with descriptors and
bytecode length. `string_constants` lists every constant-pool string literal in
pool order, subject to the 16 MiB expanded JSON text budget;
`referenced_classes` lists every class constant except the class itself. `nested_class_entries` lists sibling `Name$*.class` entries.

Literals are decoded from the JVM's modified UTF-8, so embedded NUL and
supplementary characters round-trip exactly. 64-bit `long` and `double`
constants are decimal text to stay lossless.

Renaming obfuscation removes names but leaves string literals, annotation
values, framework method names and library references intact; these are often
the fastest route to the behavior of an obfuscated class.

## Decompilation

`decompile_java_class` runs a caller-supplied
[Vineflower](https://github.com/Vineflower/vineflower) JAR. REA does not download
or install it, or Java. Configure:

- `REA_VINEFLOWER_JAR`: absolute path to the Vineflower JAR (verified with
  1.11.1);
- `JAVA_HOME` (absolute) or `java` on `PATH`: a Java 17+ runtime.

REA admits the target once, then copies the exact engine bytes, the selected
class and its nested-class entries, and the complete archive (as library
context) into a private temporary root. Vineflower runs there with
`-dgs=1 -log=WARN`, with a 180-second deadline and 8 MiB diagnostic budget. REA
re-hashes the private engine copy after the run, reads the generated source and
removes the root. A root that cannot be removed is retained and retried on the
next call or shutdown, and the failure is reported.

Archive entry names are untrusted. An entry that is not a plain relative path,
including a forged nested-class name containing `..`, is refused before any
process starts.

The Evidence is `derived`. The provider version is the engine manifest's
`Implementation-Version`, and `tool_profile` records the engine path, SHA-256,
Java executable and arguments with the private root shown as `<private-root>`.
The complete source is returned with its SHA-256. The provider does not infer
a failed-member count from arbitrary source text;
Vineflower failure comments require analyst review.

Decompiled source is a reconstruction. Renamed identifiers stay as found, and
local variable names, comments and formatting are synthesized. Classes outside
the selected archive (for example the game or framework a mod is compiled
against) are not on the library path, which can weaken inferred types.

## Example: an obfuscated Minecraft mod

On `mpkmod-1.3.0.jar` (a Forge 1.8.9 mod, 1.9 MB), measured on Linux x64 with a
warm build:

- `inspect_java_archive` (about 2 s through the CLI) reported 308 classes, its
  `mcmod.info`, native JNA and discord-rpc libraries, and `name_obfuscation`
  `likely`. Per-package counts showed every `io.github.kurrycat.mpkmod.*` class
  renamed and every bundled `com.sun.jna` and `club.minnced.discord.rpc` class
  intact. A 3-row page was about 7 KB of JSON.
- `inspect_java_class` on `io.github.kurrycat.mpkmod.a` recovered its `@Mod`
  annotation values, `@EventHandler` methods and all string literals.
- `decompile_java_class` with Vineflower 1.11.1 returned that class's source in
  about 3 s.

Agent token usage and peak memory were not measured.

## Limits

Resource guards bound the selected file to 512 MiB, entries to 200,000, each
class to 16 MiB, total decompressed class bytes to 512 MiB, the manifest to
16 MiB and the decompiled source read to 32 MiB. They are allocation guards,
not operating-system memory limits; exceeding one is a typed resource failure,
not partial success. Encrypted ZIP entries are counted but not read.

Archive selection uses each class file's declared binary name, including classes
under Spring Boot, WAR, and multi-release prefixes. If that name occurs more
than once, supply the exact `.class` entry returned by `inspect_java_archive`.
If that path itself is duplicated, use the row's unique `entry_id` (`zip-entry:N`)
as `class_name`; that identity is scoped to the selected archive digest.
REA does not silently choose a base, versioned, or duplicate occurrence.
Class-report text expansion is bounded before Evidence serialization; exceeding
the 16 MiB JSON text budget is a typed resource failure with no partial success.
Runtime annotation visibility is retained; nested annotation values have no
independent runtime visibility and record `null`. Descriptor text is
a bounded prefix; inventory limitations report descriptors omitted by the file
budget. Archive pages retain compact class facts instead of full member bodies.

Integration remains pending a maintainer scope decision for the new providers.
The decision must cover the caller-selected Java/Vineflower execution authority,
resource policy, cancellation and cleanup, and required real-provider coverage.
The simulated launcher proves staging contracts only. Real top-level and nested
class output paths have not been established by that simulation; the opt-in acceptance case uses `REA_VERIFY_VINEFLOWER_REAL=1`, the caller's
`REA_VINEFLOWER_JAR`, Java and javac to compile top-level/nested controls. Its
execution remains required before asserting real Vineflower output coverage.
