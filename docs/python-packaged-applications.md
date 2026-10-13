# Python packaged applications

REA inventories a PyInstaller executable when the native bootloader has an
appended CArchive. `inspect_artifact` and `extract_artifact` list and extract
the archive members. REA does not decrypt encrypted PYZ entries and does not
decompile bytecode.

## What the inventory reports

The root occurrence records the CArchive layout (2.0 or 2.1), the Python
version integer from the cookie, and the Python library name when the 2.1
cookie includes one.

Each table entry reports its name, type code, compression flag, declared sizes
and known source offsets. Inventory opens members individually to hash their
content; it does not retain expanded module bodies. PYZ tables declare only
compressed lengths, so uncompressed declared sizes and decoded source spans
remain unknown. Entry scripts use type `s`.
Runtime options use type `o`, and the option text is the entry name.

A PYZ archive is a nested container when its Python bytecode magic is a final
magic for Python 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13, or 3.14. The table of
contents supplies module, package, data, and namespace entries. A PYZ whose
magic is outside that set, or whose table uses a marshal type outside list,
tuple, string, integer, and bytes, stays one opaque member with a limitation.

An archive that contains the module `pyimod00_crypto_key` marks PYZ entry blobs
as encrypted. Those entries are reported and are not decoded. Extraction of an
archive that contains an encrypted entry is refused.

Compiled members are written as `.pyc` files with a reconstructed 16-byte header
when the Python magic is known. The inventory records that header as a
derivation. The member digest covers the derived file. A supported PYZ magic remains usable
for separate CArchive scripts even when the PYZ table itself stays opaque.

Detection searches the last 16 MiB of the file for the CArchive cookie, so a
macOS code signature after the cookie does not hide the archive. Member offsets
are relative to the archive start, which is the cookie position plus the cookie
size minus the package length.

```bash
rea inspect-artifact /absolute/path/hello --json
rea extract-artifact /absolute/path/hello --json
```

The bootloader remains a native executable. Use the native analysis tools when
the question is about the bootloader rather than the packaged Python
application.
