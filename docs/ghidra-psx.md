# PlayStation PS-X EXE static analysis

REA recognizes the `PS-X EXE` signature and retains `format=psx-exe` and
`architecture=mips` through its existing CLI, MCP, Evidence and snapshots.
Use an extracted executable, such as the file named by a disc's `SYSTEM.CNF`.
Disc images, NSF archives, overlays and GOOL bytecode are not executable loaders.

```sh
rea function /path/to/executable 0x80010010 --provider ghidra --json
```

The `psx-exe-r3000a-static-v1` profile imports the complete original file with
Ghidra's BinaryLoader, then maps only the declared payload at the header's
load address. File offset `0x800` corresponds to that address; the entry can
be elsewhere in the payload. The pre-analysis script verifies the original
header against the committed profile, seeds the entry function and declared
GP and nonzero-base SP, and creates an uninitialized BSS block when declared.
A zero stack base means the incoming stack is unknown, not zero. The reserved
data-address/data-size fields are retained without inventing another mapping.

The admitted load/BSS ranges fit original PlayStation 2 MiB RAM, through its
physical, KSEG0 or KSEG1 addresses. Truncated files, overlapping physical
ranges, address overflow and entries outside the payload are rejected. This
is a bounded static loader; other RAM sizes and alias mappings are not inferred.

The profile pins `MIPS:LE:32:default` / `default` and rejects processor overrides.
It preserves the full original file digest and original-file byte offsets;
target bytes are never rewritten. Ghidra databases remain ephemeral. The
profile and Evidence limitations explicitly state that generic MIPS decoding
is **not R3000A execution emulation**: GTE operations, load-delay behavior,
BIOS calls, overlay discovery, runtime addresses and reconstructed game physics
are unverified. The independent native load-image attestation operation does
not yet certify this format; byte reads and offset mapping remain available.

## Verification

With an existing Ghidra installation and compatible JDK:

```sh
GHIDRA_INSTALL_DIR=/path/to/ghidra JAVA_HOME=/path/to/jdk npm run verify:ghidra:psx
```

This uses an original source-owned fixture with separate entry/load addresses,
GP/SP and BSS declarations. It exercises actual public CLI and MCP workflows,
checks decoded instructions against original file bytes, exact offsets,
Evidence identity, snapshot replay, and unchanged source bytes. It installs
nothing and executes no target code. macOS arm64, Ghidra 12.1.2 and JDK 26 were
verified during implementation; other provider/host combinations are not
established by that result. No commercial executable belongs in the fixture.

The source extent is limited to the declared payload plus its 2048-byte header
and padding through the final 2048-byte sector. Additional trailing sectors are
rejected before hashing or creating the analysis snapshot.
