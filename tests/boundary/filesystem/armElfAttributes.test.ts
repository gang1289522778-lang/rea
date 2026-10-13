import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/**
 * Real .ARM.attributes payloads dumped from clang 21.1.8 objects on the
 * verification host: 'A', a 4-byte subsection length, the aeabi owner, a
 * file-scope block, then Tag_CPU_arch (6) with its enum value.
 */
const V7_ATTRIBUTES = Buffer.from([
  0x41, 0x1b, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x11,
  0x00, 0x00, 0x00, 0x06, 0x0a, 0x07, 0x41, 0x08, 0x01, 0x09, 0x02, 0x0a, 0x04,
  0x22, 0x01,
]);
const V8_ATTRIBUTES = Buffer.from([
  0x41, 0x23, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x19,
  0x00, 0x00, 0x00, 0x06, 0x0e, 0x07, 0x41, 0x08, 0x01, 0x09, 0x02, 0x0a, 0x07,
  0x0c, 0x03, 0x22, 0x01, 0x24, 0x01, 0x2a, 0x01, 0x44, 0x03,
]);
const V6_ATTRIBUTES = Buffer.from([
  0x41, 0x21, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x17,
  0x00, 0x00, 0x00, 0x05, 0x6d, 0x70, 0x63, 0x6f, 0x72, 0x65, 0x00, 0x06, 0x06,
  0x08, 0x01, 0x09, 0x01, 0x0a, 0x02, 0x22, 0x00,
]);
/**
 * Real cortex-r5 payload: Tag_CPU_arch v7 with the Realtime profile, so the
 * arch enum alone would admit an ISA variant the lane never verified.
 */
const R5_ATTRIBUTES = Buffer.from([
  0x41, 0x28, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x1e,
  0x00, 0x00, 0x00, 0x05, 0x63, 0x6f, 0x72, 0x74, 0x65, 0x78, 0x2d, 0x72, 0x35,
  0x00, 0x06, 0x0a, 0x07, 0x52, 0x08, 0x01, 0x09, 0x02, 0x0a, 0x04, 0x22, 0x01,
  0x2c, 0x02,
]);
/** An empty File scope; the 06 0a bytes live only inside a Symbol scope
 * after its NUL-terminated index list. */
const SYMBOL_SCOPE_ATTRIBUTES = Buffer.from([
  0x41, 0x18, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x05,
  0x00, 0x00, 0x00, 0x03, 0x09, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x0a,
]);
/** A valid v7 File scope followed by a Symbol scope repeating the bytes
 * after its index list. */
const FILE_THEN_SYMBOL_ATTRIBUTES = Buffer.from([
  0x41, 0x24, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x11,
  0x00, 0x00, 0x00, 0x06, 0x0a, 0x07, 0x41, 0x08, 0x01, 0x09, 0x02, 0x0a, 0x04,
  0x22, 0x01, 0x03, 0x09, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x0a,
]);
/** Two File scopes declaring v7 then v8; sequential consumers take the last. */
const DUPLICATE_FILE_SCOPES_ATTRIBUTES = Buffer.from([
  0x41, 0x22, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x11,
  0x00, 0x00, 0x00, 0x06, 0x0a, 0x07, 0x41, 0x08, 0x01, 0x09, 0x02, 0x0a, 0x04,
  0x22, 0x01, 0x01, 0x07, 0x00, 0x00, 0x00, 0x06, 0x0e,
]);
/** A File block opening with Tag_NULL before the declarations. */
const TAG_ZERO_ATTRIBUTES = Buffer.from([
  0x41, 0x18, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x0e,
  0x00, 0x00, 0x00, 0x00, 0x06, 0x0a, 0x07, 0x41, 0x08, 0x01, 0x09, 0x02,
]);
/** A v7 File scope declaring the Not Applicable profile (value zero). */
const NOT_APPLICABLE_PROFILE_ATTRIBUTES = Buffer.from([
  0x41, 0x1b, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x11,
  0x00, 0x00, 0x00, 0x06, 0x0a, 0x07, 0x00, 0x08, 0x01, 0x09, 0x02, 0x0a, 0x04,
  0x22, 0x01,
]);
/** A valid v7/A block ending with the no-value Tag_nodefaults marker (64). */
const NODEFAULTS_ATTRIBUTES = Buffer.from([
  0x41, 0x1a, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x10,
  0x00, 0x00, 0x00, 0x06, 0x0a, 0x07, 0x41, 0x40, 0x08, 0x01, 0x09, 0x02, 0x0a,
  0x04,
]);
/** A v7/A block followed by Tag_also_compatible_with (65), a string tag. */
const STRING_TAG_ATTRIBUTES = Buffer.concat([
  Buffer.from([
    0x41, 0x1f, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01,
    0x15, 0x00, 0x00, 0x00, 0x06, 0x0a, 0x07, 0x41, 0x08, 0x01, 0x09, 0x02,
    0x41,
  ]),
  Buffer.from("v6\u0000", "ascii"),
  Buffer.from([0x0a, 0x04, 0x22, 0x01]),
]);
/** One File scope declaring v7 twice with conflicting values. */
const CONFLICTING_FILE_ATTRIBUTES = Buffer.from([
  0x41, 0x1d, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x13,
  0x00, 0x00, 0x00, 0x06, 0x0a, 0x06, 0x0e, 0x07, 0x41, 0x08, 0x01, 0x09, 0x02,
]);
/** A v7/A File scope beside a Symbol scope declaring v8 after its index
 * list; the old fixture's subsection length also ran past the payload, so
 * it refused as malformed instead of reaching the conflict. */
const SCOPED_CONFLICT_ATTRIBUTES = Buffer.from([
  0x41, 0x24, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x11,
  0x00, 0x00, 0x00, 0x06, 0x0a, 0x07, 0x41, 0x08, 0x01, 0x09, 0x02, 0x0a, 0x04,
  0x22, 0x01, 0x03, 0x09, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x0e,
]);
/** Two aeabi subsections agreeing on v7; the walk must merge them. */
const DUAL_SUBSECTION_AGREEING_ATTRIBUTES = Buffer.from([
  0x41, 0x11, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x07,
  0x00, 0x00, 0x00, 0x06, 0x0a, 0x11, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62,
  0x69, 0x00, 0x01, 0x07, 0x00, 0x00, 0x00, 0x06, 0x0a,
]);
/** A second aeabi subsection declaring v8 conflicts with the first v7. */
const DUAL_SUBSECTION_CONFLICT_ATTRIBUTES = Buffer.from([
  0x41, 0x11, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x07,
  0x00, 0x00, 0x00, 0x06, 0x0a, 0x11, 0x00, 0x00, 0x00, 0x61, 0x65, 0x61, 0x62,
  0x69, 0x00, 0x01, 0x07, 0x00, 0x00, 0x00, 0x06, 0x0e,
]);
// Same shape with an impossible subsection length spanning past the section.
const MALFORMED_ATTRIBUTES = Buffer.from([
  0x41, 0xff, 0xff, 0xff, 0x0f, 0x61, 0x65, 0x61, 0x62, 0x69, 0x00, 0x01, 0x11,
  0x00, 0x00, 0x00, 0x06, 0x0a, 0x07, 0x41, 0x08, 0x01, 0x09, 0x02, 0x0a, 0x04,
  0x22, 0x01,
]);

const SECTION_TABLE_OFFSET = 128;
// Deliberately outside BinaryTargetResolver's 4 KiB probe: the declaration
// must survive being read file-level, like the MIPS ABI record.
const ATTRIBUTES_OFFSET = 8192;

const armFixture = (
  attributes: Buffer | null,
  options: { truncatedTable?: boolean; stride?: number } = {},
): Buffer => {
  const sectionCount = attributes === null ? 1 : 2;
  const truncated = options.truncatedTable === true;
  const bytes = Buffer.alloc(
    truncated
      ? // Room for the null entry and most of the second header.
        SECTION_TABLE_OFFSET + 64
      : Math.max(
          ATTRIBUTES_OFFSET + (attributes === null ? 0 : attributes.length),
          ATTRIBUTES_OFFSET + 64,
        ),
  );
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  bytes.writeUInt16LE(2, 16); // ET_EXEC
  bytes.writeUInt16LE(40, 18); // EM_ARM
  bytes.writeUInt32LE(1, 20);
  bytes.writeUInt32LE(SECTION_TABLE_OFFSET, 32); // e_shoff
  bytes.writeUInt32LE(0x05000400, 36); // EABI5, hard float
  bytes.writeUInt16LE(52, 40); // e_ehsize
  bytes.writeUInt16LE(options.stride ?? 40, 46); // e_shentsize
  bytes.writeUInt16LE(sectionCount, 48); // e_shnum
  if (attributes !== null) {
    const header = SECTION_TABLE_OFFSET + 40;
    bytes.writeUInt32LE(0x70000003, header + 4); // SHT_ARM_ATTRIBUTES
    bytes.writeUInt32LE(ATTRIBUTES_OFFSET, header + 16);
    bytes.writeUInt32LE(attributes.length, header + 20);
    if (!truncated) bytes.set(attributes, ATTRIBUTES_OFFSET);
  }
  return bytes;
};

const resolveArm = async (bytes: Buffer) => {
  const directory = await createTestTempDirectory("rea-arm-attrs-");
  const path = join(directory, "fixture.elf");
  await writeFile(path, bytes);
  const result = await parseBinaryTarget(path);
  if (!result.ok) throw result.error;
  if (result.value.kind !== "executable" || result.value.architecture !== "arm")
    throw new Error("Expected a resolved ARM executable");
  return result.value;
};

it("reads Tag_CPU_arch v7 from a real attributes payload beyond the probe", async () => {
  const target = await resolveArm(armFixture(V7_ATTRIBUTES));
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBe(10);
});

it("reads Tag_CPU_arch v8-A from a real attributes payload", async () => {
  const target = await resolveArm(armFixture(V8_ATTRIBUTES));
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBe(14);
});

it("reads Tag_CPU_arch v6 from a payload with a CPU_name string tag", async () => {
  const target = await resolveArm(armFixture(V6_ATTRIBUTES));
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBe(6);
});

it("reports no declaration when no attributes section exists", async () => {
  const target = await resolveArm(armFixture(null));
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBeNull();
  expect(target.arm.limitations).toBeUndefined();
});

it("reports no declaration for a malformed attributes payload", async () => {
  const target = await resolveArm(armFixture(MALFORMED_ATTRIBUTES));
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBeNull();
});

it("reads the Realtime profile from a real cortex-r5 payload", async () => {
  const target = await resolveArm(armFixture(R5_ATTRIBUTES));
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBe(10);
  expect(target.arm.cpuArchProfile).toBe("R");
});

it("never reads Symbol-scope bytes as a CPU_arch declaration", async () => {
  const target = await resolveArm(armFixture(SYMBOL_SCOPE_ATTRIBUTES));
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBeNull();
  expect(target.arm.cpuArchProfile).toBeNull();
});

it("reads the File scope declaration with a Symbol scope following it", async () => {
  const target = await resolveArm(armFixture(FILE_THEN_SYMBOL_ATTRIBUTES));
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBe(10);
  expect(target.arm.cpuArchProfile).toBe("A");
});

it("reads conflicting File-scope declarations as no declaration", async () => {
  const target = await resolveArm(armFixture(DUPLICATE_FILE_SCOPES_ATTRIBUTES));
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBeNull();
  expect(target.arm.cpuArchProfile).toBeNull();
});

it("merges two agreeing aeabi subsections into one declaration", async () => {
  const target = await resolveArm(
    armFixture(DUAL_SUBSECTION_AGREEING_ATTRIBUTES),
  );
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBe(10);
  expect(target.arm.cpuArchProfile).toBeNull();
});

it("reads a second aeabi subsection disagreeing with the first as no declaration", async () => {
  const target = await resolveArm(
    armFixture(DUAL_SUBSECTION_CONFLICT_ATTRIBUTES),
  );
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBeNull();
});

it("records a limitation when the section table extends beyond the file", async () => {
  const target = await resolveArm(
    armFixture(V7_ATTRIBUTES, { truncatedTable: true }),
  );
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBeNull();
  expect(target.arm.limitations?.join(" ")).toContain(
    "extends beyond the captured file",
  );
});

it("rejects a File block whose declarations follow Tag_NULL", async () => {
  const target = await resolveArm(armFixture(TAG_ZERO_ATTRIBUTES));
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBeNull();
  expect(target.arm.cpuArchProfile).toBeNull();
});

it("preserves the declared Not Applicable profile with the arch enum", async () => {
  const target = await resolveArm(
    armFixture(NOT_APPLICABLE_PROFILE_ATTRIBUTES),
  );
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBe(10);
  expect(target.arm.cpuArchProfile).toBe("\u0000");
});

it("accepts a File block ending with Tag_nodefaults", async () => {
  const target = await resolveArm(armFixture(NODEFAULTS_ATTRIBUTES));
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBe(10);
  expect(target.arm.cpuArchProfile).toBe("A");
});

it("skips string-valued odd tags without consuming the declarations", async () => {
  const target = await resolveArm(armFixture(STRING_TAG_ATTRIBUTES));
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBe(10);
  expect(target.arm.cpuArchProfile).toBe("A");
});

it("reads conflicting ISA tags inside one File scope as no declaration", async () => {
  const target = await resolveArm(armFixture(CONFLICTING_FILE_ATTRIBUTES));
  if (target.format !== "elf") throw new Error("Expected an ELF target");
  expect(target.arm.cpuArch).toBeNull();
});

it.each([
  SCOPED_CONFLICT_ATTRIBUTES,
  Buffer.concat([
    SCOPED_CONFLICT_ATTRIBUTES.subarray(0, 11),
    SCOPED_CONFLICT_ATTRIBUTES.subarray(28),
    SCOPED_CONFLICT_ATTRIBUTES.subarray(11, 28),
  ]),
])(
  "reconciles scoped declarations regardless of File-scope order",
  async (attributes) => {
    const target = await resolveArm(armFixture(attributes));
    if (target.format !== "elf") throw new Error("Expected an ELF target");
    expect(target.arm.cpuArch).toBeNull();
  },
);

it("preserves ARM target identity when extended section coverage is unavailable", async () => {
  const bytes = armFixture(V7_ATTRIBUTES);
  bytes.writeUInt16LE(0, 48);
  bytes.writeUInt32LE(2, SECTION_TABLE_OFFSET + 20);
  const target = await resolveArm(bytes);
  expect(target).toMatchObject({
    architecture: "arm",
    format: "elf",
    arm: {
      cpuArch: null,
      cpuArchProfile: null,
      limitations: [expect.stringContaining("Extended ARM section numbering")],
    },
  });
});

it("refuses a padded section-table entry size instead of allocating it", async () => {
  const directory = await createTestTempDirectory("rea-arm-stride-");
  const path = join(directory, "fixture.elf");
  await writeFile(path, armFixture(V7_ATTRIBUTES, { stride: 0x2000 }));
  const result = await parseBinaryTarget(path);
  expect(result.ok).toBe(false);
  expect(String((result as { error?: unknown }).error)).toContain(
    "invalid ARM section table offset or entry size",
  );
});
