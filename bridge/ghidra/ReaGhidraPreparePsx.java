import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.database.mem.FileBytes;
import ghidra.program.model.mem.MemoryBlock;

/** Validate the original PS-X header and seed its entry before auto-analysis. */
public final class ReaGhidraPreparePsx extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 8 || !currentProgram.getLanguageID().getIdAsString().equals("MIPS:LE:32:default") ||
            !currentProgram.getExecutableFormat().equals("Raw Binary")) {
            throw new IllegalArgumentException("PS-X EXE requires its committed loader and language");
        }
        long[] values = new long[8];
        int[] offsets = { 0x18, 0x1c, 0x10, 0x14, 0x30, 0x34, 0x28, 0x2c };
        if (currentProgram.getMemory().getAllFileBytes().size() != 1)
            throw new IllegalArgumentException("Expected one original PS-X file");
        FileBytes file = currentProgram.getMemory().getAllFileBytes().get(0);
        byte[] header = new byte[2048];
        if (file.getOriginalBytes(0, header) != header.length ||
            !new String(header, 0, 8, java.nio.charset.StandardCharsets.US_ASCII).equals("PS-X EXE"))
            throw new IllegalArgumentException("Original PS-X EXE header unavailable");
        ByteBuffer source = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < values.length; i++) {
            values[i] = Long.parseLong(args[i]);
            if (values[i] != Integer.toUnsignedLong(source.getInt(offsets[i])))
                throw new IllegalArgumentException("PS-X header differs from committed profile");
        }
        Address base = toAddr(values[0]);
        MemoryBlock[] imported = currentProgram.getMemory().getBlocks();
        if (imported.length != 1 || imported[0].getStart().getOffset() != 0 || imported[0].getSize() != file.getSize())
            throw new IllegalArgumentException("Expected an unchanged complete BinaryLoader import");
        currentProgram.getMemory().removeBlock(imported[0], monitor);
        currentProgram.setImageBase(base, true);
        MemoryBlock block = currentProgram.getMemory().createInitializedBlock("psx_payload", base, file, 2048, values[1], false);
        block.setRead(true);
        block.setWrite(true);
        block.setExecute(true);
        if (values[7] != 0) {
            MemoryBlock bss = currentProgram.getMemory().createUninitializedBlock("psx_bss", toAddr(values[6]), values[7], false);
            bss.setWrite(true);
        }
        Address entry = toAddr(values[2]);
        // A zero stack base leaves the BIOS/caller stack unchanged, hence unknown here.
        if (values[4] != 0) {
            BigInteger stack = BigInteger.valueOf(values[4] + values[5]);
            var frame = currentProgram.getRegister("fp");
            if (frame == null) frame = currentProgram.getRegister("s8");
            if (frame == null) throw new IllegalStateException("MIPS frame-pointer register is unavailable");
            currentProgram.getProgramContext().setValue(currentProgram.getRegister("sp"), entry, entry, stack);
            currentProgram.getProgramContext().setValue(frame, entry, entry, stack);
        }
        currentProgram.getProgramContext().setValue(currentProgram.getRegister("gp"), entry, entry, BigInteger.valueOf(values[3]));
        addEntryPoint(entry);
        disassemble(entry);
        if (getInstructionAt(entry) == null)
            throw new IllegalStateException("PS-X entry cannot be decoded at " + entry);
        if (getFunctionAt(entry) == null && createFunction(entry, "entry") == null)
            throw new IllegalStateException("PS-X entry function cannot be created at " + entry);
        currentProgram.getOptions(ghidra.program.model.listing.Program.PROGRAM_INFO).setBoolean("REA PS-X EXE prepared", true);
    }
}
