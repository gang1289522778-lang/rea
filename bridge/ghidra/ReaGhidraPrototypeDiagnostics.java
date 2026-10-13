// Read-only, deliberately bounded instruction checks. No inferred type is repaired.
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.DataType;
import ghidra.program.model.data.Undefined;
import ghidra.program.model.data.VoidDataType;
import ghidra.program.model.lang.Register;
import ghidra.program.model.lang.PrototypeModel;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Program;
import ghidra.program.model.pcode.FunctionPrototype;
import ghidra.program.model.pcode.PcodeOp;
import ghidra.program.model.pcode.Varnode;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.util.task.TaskMonitor;

public final class ReaGhidraPrototypeDiagnostics {
    // Shared epilogues and call/return observations are probes, not CFG recovery.
    private static final int EPILOGUE_INSTRUCTIONS = 16;
    private static final int ENTRY_INSTRUCTIONS = 256;
    private static final int ENTRY_PCODE_OPERATIONS = 2048;
    private static final int ENTRY_FACTS = 256;
    // Bound the aggregate forwarding evidence retained in one dossier.
    private static final int FORWARDING_EVIDENCE_BUDGET = 256;

    public static JsonObject inspect(Program program, Function function,
            FunctionPrototype prototype, TaskMonitor monitor,
            java.util.function.Function<Address, String> addressText) throws Exception {
        JsonObject result = new JsonObject();
        JsonArray diagnostics = new JsonArray();
        JsonArray limitations = new JsonArray();
        result.add("diagnostics", diagnostics);
        result.add("limitations", limitations);
        if (!program.getLanguage().getProcessor().toString().equals("x86") ||
                program.getLanguage().getLanguageDescription().getSize() != 32) {
            limitations.add("Instruction/prototype checks support x86-32 only; consistency on this target remains unknown.");
            return result;
        }
        limitations.add("Stack-read checks cover the straight-line entry prefix before its first architectural or raw p-code control transfer. Calls, joins, aliases and dynamic stack adjustments are not propagated; absence of a diagnostic does not establish prototype consistency.");
        limitations.add("Return cleanup is compared with recovered stack-storage extent including compiler-model slot padding, not a source argument count. Custom or unknown slot allocation is not classified as a cleanup conflict. Shared epilogues are followed for at most 16 simple instructions without expanding owned-body ranges; indirect flows, tail calls and longer paths remain unknown.");
        limitations.add("Return-register forwarding is a bounded EAX observation, not proof of a source return type. x87 instructions preserve inputs and operations, not a complete expression, missing multiplier, signedness or compiler identity.");
        List<Varnode> parameters = new ArrayList<>();
        List<long[]> slots = new ArrayList<>();
        String modelName = prototype.getModelName();
        PrototypeModel model = modelName == null ? null : program.getCompilerSpec().getCallingConvention(modelName);
        PrototypeModel allocationModel = model;
        boolean knownAllocation = !function.hasCustomVariableStorage() && allocationModel != null &&
            !allocationModel.isMerged() && !allocationModel.isProgramExtension() &&
            allocationModel.getStackshift() == 4 && Long.valueOf(4).equals(allocationModel.getStackParameterOffset()) &&
            allocationModel.getStackParameterAlignment() == 4;
        long stackEnd = 4;
        for (int index = 0; index < prototype.getNumParams(); index++) {
            if (prototype.getParam(index) == null) continue;
            for (Varnode node : prototype.getParam(index).getStorage().getVarnodes()) {
                if (!node.getAddress().getAddressSpace().isStackSpace()) continue;
                if (prototype.getParam(index).getDataType().getAlignment() > 4 ||
                    prototype.getParam(index).getDataType().getAlignedLength() > ((node.getSize() + 3) / 4) * 4)
                    knownAllocation = false;
                parameters.add(node);
                long end = node.getOffset() + node.getSize();
                if (node.getOffset() < 4 || node.getOffset() % 4 != 0) knownAllocation = false;
                slots.add(new long[] { node.getOffset(), 4 + ((end - 4 + 3) / 4) * 4 });
                stackEnd = Math.max(stackEnd, end);
            }
        }
        if (knownAllocation) stackEnd = 4 + ((stackEnd - 4 + 3) / 4) * 4;
        if (!knownAllocation) limitations.add("Compiler-model x86 stack-slot allocation could not be established; padding reads and return cleanup remain observations or unknowns.");
        Long expectedCleanup = model != null && !model.isProgramExtension() && !model.isMerged() &&
            model.getExtrapop() != PrototypeModel.UNKNOWN_EXTRAPOP && model.getExtrapop() >= model.getStackshift()
            ? (long) model.getExtrapop() - model.getStackshift() : null;
        if (expectedCleanup == null) limitations.add("The compiler model does not establish a cleanup byte count; RET/stack-extent differences remain observations, not prototype conflicts.");
        String claim = "The recovered prototype has " + prototype.getNumParams() +
            " parameters and " + (stackEnd - 4) + " bytes of recovered x86 stack-argument extent" +
            (knownAllocation ? " including compiler-model slot padding" : " with allocation unknown") +
            " (calling convention " + (modelName == null ? "unknown" : modelName) + ").";
        Register esp = program.getRegister("ESP");
        Register eax = program.getRegister("EAX");
        if (esp == null || eax == null) {
            limitations.add("Required ESP/EAX register identities are unavailable; instruction checks were not performed.");
            return result;
        }
        Map<Varnode, Long> offsets = new HashMap<>();
        offsets.put(new Varnode(esp.getAddress(), 4), 0L);
        JsonArray x87 = new JsonArray();
        List<long[]> writtenStack = new ArrayList<>();
        boolean unknownStore = false;
        Set<Address> visited = new HashSet<>();
        Instruction instruction = program.getListing().getInstructionAt(function.getEntryPoint());
        int entryInstructions = 0;
        int entryOperations = 0;
        int entryFacts = 0;
        boolean entryLimited = false;
        entryPrefix: while (instruction != null && function.getBody().contains(instruction.getAddress()) &&
                visited.add(instruction.getAddress())) {
            monitor.checkCancelled();
            if (entryInstructions >= ENTRY_INSTRUCTIONS || entryFacts >= ENTRY_FACTS) {
                entryLimited = true;
                break;
            }
            entryInstructions++;
            if (instruction.getFlowType().isCall()) {
                if (!x87.isEmpty()) x87.add(evidence("call-site", instruction,
                    "Call following x87 operations: " + instruction, addressText));
                break;
            }
            if (instruction.getFlowType().isJump() || instruction.getFlowType().isTerminal()) break;
            PcodeOp[] operations = instruction.getPcode();
            if (operations.length > ENTRY_PCODE_OPERATIONS - entryOperations) {
                entryLimited = true;
                break;
            }
            entryOperations += operations.length;
            boolean internalFlow = false;
            boolean returns = false;
            for (PcodeOp operation : operations) {
                if (operation.getOpcode() == PcodeOp.RETURN) returns = true;
                if (operation.getOpcode() == PcodeOp.BRANCH || operation.getOpcode() == PcodeOp.CBRANCH ||
                    operation.getOpcode() == PcodeOp.BRANCHIND || operation.getOpcode() == PcodeOp.CALL ||
                    operation.getOpcode() == PcodeOp.CALLIND || operation.getOpcode() == PcodeOp.CALLOTHER) internalFlow = true;
            }
            if (returns) break;
            if (internalFlow) {
                limitations.add("Raw p-code control flow at " + addressText.apply(instruction.getAddress()) +
                    " or an unsupported user-op makes subsequent stack offsets or memory effects ambiguous; entry stack-read propagation stopped.");
                break;
            }
            offsets.keySet().removeIf(Varnode::isUnique);
            if (instruction.getMnemonicString().toUpperCase(Locale.ROOT).startsWith("F")) {
                x87.add(evidence("instruction", instruction, "Observed x87 instruction: " + instruction, addressText));
                entryFacts++;
            }
            for (PcodeOp operation : operations) {
                monitor.checkCancelled();
                if (entryFacts >= ENTRY_FACTS) {
                    entryLimited = true;
                    break entryPrefix;
                }
                if (operation.getOpcode() == PcodeOp.STORE) {
                    Long offset = offsets.get(operation.getInput(1));
                    if (offset == null) {
                        if (!unknownStore) {
                            entryFacts++;
                            limitations.add("A store with unresolved aliasing at " + addressText.apply(instruction.getAddress()) +
                                " prevents subsequent stack reads from establishing unmodified entry inputs.");
                        }
                        unknownStore = true;
                    } else writtenStack.add(new long[] { offset, offset + operation.getInput(2).getSize() });
                }
                if (operation.getOpcode() == PcodeOp.LOAD) {
                    Long offset = offsets.get(operation.getInput(1));
                    int size = operation.getOutput().getSize();
                    if (offset != null && offset >= 4 && !covered(parameters, offset, size) &&
                            !(knownAllocation && coveredSlots(slots, offset, size))) {
                        entryFacts++;
                        if (unknownStore || overlaps(writtenStack, offset, size)) {
                            limitations.add("Stack read at " + addressText.apply(instruction.getAddress()) +
                                " may contain data written by this entry prefix; an omitted entry input was not established.");
                        } else {
                            JsonArray facts = new JsonArray();
                            facts.add(evidence("stack-read", instruction,
                                "Raw instruction p-code reads " + size + " bytes at entry ESP + " + offset +
                                ", outside recovered parameter storage" + (knownAllocation ? " and its compiler-model slots." : "."), addressText));
                            boolean conflict = !prototype.isVarArg() && (knownAllocation || parameters.isEmpty());
                            diagnostics.add(diagnostic("stack-parameter-read", conflict ? "conflict" : "observation", claim, facts,
                                "The read may reflect an omitted, hidden or variadic input, ABI padding, a custom ABI or stack data; its source type and source parameter count remain unknown."));
                        }
                    }
                }
                Varnode output = operation.getOutput();
                if (output == null) continue;
                Long value = propagatedOffset(operation, offsets);
                offsets.keySet().removeIf(node -> node.intersects(output));
                if (value != null) offsets.put(output, value);
            }
            Address next = instruction.getFallThrough();
            instruction = next == null ? null : program.getListing().getInstructionAt(next);
        }
        if (entryLimited) limitations.add("Entry-prefix checks reached their budget of 256 instructions, 2048 raw p-code operations or 256 facts; remaining entry instructions and stack inputs were not examined.");
        if (!x87.isEmpty()) diagnostics.add(diagnostic("x87-expression", "observation", claim, x87,
            "The x87 entry inputs and listed operations do not establish a complete expression or the semantics of a following call. Missing factors, conversion type, signedness and compiler identity remain unknown."));

        Set<Address> reportedReturns = new HashSet<>();
        JsonArray forwardingFacts = new JsonArray();
        Set<Address> forwardingAddresses = new HashSet<>();
        boolean forwardingLimited = false;
        InstructionIterator instructions = program.getListing().getInstructions(function.getBody(), true);
        while (instructions.hasNext()) {
            monitor.checkCancelled();
            Instruction item = instructions.next();
            if (isReturn(item) && knownAllocation) cleanupDiagnostic(item, null, stackEnd - 4, prototype, expectedCleanup, claim,
                diagnostics, reportedReturns, addressText);
            if (item.getFlowType().isJump() && !item.getFlowType().isConditional() && !item.getFlowType().isComputed()) {
                Address[] targets = item.getFlows();
                if (targets.length == 1 && !function.getBody().contains(targets[0])) {
                    Instruction returned = epilogueReturn(program, function, targets[0], eax, false, monitor);
                    if (returned != null) {
                        if (knownAllocation) cleanupDiagnostic(returned, item, stackEnd - 4, prototype, expectedCleanup, claim,
                            diagnostics, reportedReturns, addressText);
                    }
                    else limitations.add("Shared epilogue or tail-call target from " + addressText.apply(item.getAddress()) +
                        " could not be established within the bounded cleanup check.");
                }
            }
            DataType returnType = prototype.getReturnType();
            if (!item.getFlowType().isCall() || !(returnType instanceof VoidDataType || Undefined.isUndefined(returnType))) continue;
            if (forwardingFacts.size() + 2 > FORWARDING_EVIDENCE_BUDGET) {
                forwardingLimited = true;
                continue;
            }
            Instruction returned = epilogueReturn(program, function, item.getFallThrough(), eax, true, monitor);
            if (returned == null) continue;
            if (forwardingAddresses.add(item.getAddress())) forwardingFacts.add(evidence("call-site", item,
                "Call followed by a simple epilogue with no raw p-code write to EAX.", addressText));
            if (forwardingAddresses.add(returned.getAddress())) forwardingFacts.add(evidence("return", returned,
                "Return reached with a checked call's EAX register unmodified by its epilogue.", addressText));
        }
        if (!forwardingFacts.isEmpty()) {
            // Incoming continuations corroborate the function, rather than each
            // outgoing branch. Visit them once and retain each source address once.
            ReferenceIterator callers = program.getReferenceManager().getReferencesTo(function.getEntryPoint());
            while (callers.hasNext()) {
                monitor.checkCancelled();
                if (forwardingFacts.size() >= FORWARDING_EVIDENCE_BUDGET) {
                    forwardingLimited = true;
                    break;
                }
                Reference reference = callers.next();
                if (!reference.getReferenceType().isCall()) continue;
                Instruction caller = program.getListing().getInstructionAt(reference.getFromAddress());
                if (caller == null || caller.getFallThrough() == null) continue;
                Instruction use = program.getListing().getInstructionAt(caller.getFallThrough());
                if (use != null && readsRegister(use, eax) && forwardingAddresses.add(use.getAddress()))
                    forwardingFacts.add(evidence("instruction", use,
                        "The immediate caller continuation reads EAX in raw p-code; return intent is not established.", addressText));
            }
            diagnostics.add(diagnostic("return-register-forwarding", "observation",
                "The recovered return type is " + prototype.getReturnType().getDisplayName() + ".", forwardingFacts,
                "EAX may be an incidental live register. Callee return semantics, caller data flow and the source return type require corroboration."));
        }
        if (forwardingLimited) limitations.add("Return-register forwarding reached its 256-fact evidence budget; remaining call paths or incoming references were not examined for forwarding. Cleanup checks retain their separate coverage.");
        return result;
    }

    private static boolean covered(List<Varnode> parameters, long offset, int size) {
        for (int index = 0; index < size; index++) {
            long byteOffset = offset + index;
            if (parameters.stream().noneMatch(node -> byteOffset >= node.getOffset() &&
                    byteOffset < node.getOffset() + node.getSize())) return false;
        }
        return true;
    }

    private static boolean coveredSlots(List<long[]> slots, long offset, int size) {
        for (int index = 0; index < size; index++) {
            long byteOffset = offset + index;
            if (slots.stream().noneMatch(slot -> byteOffset >= slot[0] && byteOffset < slot[1])) return false;
        }
        return true;
    }

    private static boolean overlaps(List<long[]> ranges, long offset, int size) {
        return ranges.stream().anyMatch(range -> offset < range[1] && offset + size > range[0]);
    }

    private static Long propagatedOffset(PcodeOp operation, Map<Varnode, Long> offsets) {
        if (operation.getOpcode() == PcodeOp.COPY) return offsets.get(operation.getInput(0));
        if (operation.getOpcode() != PcodeOp.INT_ADD && operation.getOpcode() != PcodeOp.INT_SUB) return null;
        Long left = offsets.get(operation.getInput(0));
        Varnode right = operation.getInput(1);
        if (left != null && right.isConstant()) {
            long constant = signedConstant(right);
            return operation.getOpcode() == PcodeOp.INT_ADD ? left + constant : left - constant;
        }
        if (operation.getOpcode() == PcodeOp.INT_ADD && operation.getInput(0).isConstant()) {
            Long rightOffset = offsets.get(right);
            if (rightOffset != null) return rightOffset + signedConstant(operation.getInput(0));
        }
        return null;
    }

    private static long signedConstant(Varnode constant) {
        int shift = 64 - constant.getSize() * 8;
        return shift > 0 ? (constant.getOffset() << shift) >> shift : constant.getOffset();
    }

    private static boolean isReturn(Instruction instruction) {
        for (PcodeOp operation : instruction.getPcode()) if (operation.getOpcode() == PcodeOp.RETURN) return true;
        return false;
    }

    private static boolean writesRegister(Instruction instruction, Register register) {
        Varnode node = new Varnode(register.getAddress(), register.getMinimumByteSize());
        for (PcodeOp operation : instruction.getPcode())
            if (operation.getOpcode() == PcodeOp.CALLOTHER || operation.getOutput() != null && node.intersects(operation.getOutput())) return true;
        return false;
    }

    private static boolean readsRegister(Instruction instruction, Register register) {
        Varnode node = new Varnode(register.getAddress(), register.getMinimumByteSize());
        for (PcodeOp operation : instruction.getPcode()) {
            // Equal-input XOR/SUB and constant-annihilating arithmetic do not
            // consume the incoming value. Register writes still kill that value
            // before later flag p-code reads the new result.
            boolean independent = operation.getNumInputs() == 2 &&
                ((operation.getOpcode() == PcodeOp.INT_XOR || operation.getOpcode() == PcodeOp.INT_SUB ||
                  operation.getOpcode() == PcodeOp.INT_LESS || operation.getOpcode() == PcodeOp.INT_SBORROW) &&
                  operation.getInput(0).equals(operation.getInput(1)) ||
                 (operation.getOpcode() == PcodeOp.INT_AND || operation.getOpcode() == PcodeOp.INT_MULT) &&
                  (isConstant(operation.getInput(0), 0) || isConstant(operation.getInput(1), 0)) ||
                 operation.getOpcode() == PcodeOp.INT_OR &&
                  (isConstant(operation.getInput(0), -1) || isConstant(operation.getInput(1), -1)));
            if (!independent)
                for (int i = 0; i < operation.getNumInputs(); i++) if (node.intersects(operation.getInput(i))) return true;
            if (operation.getOutput() != null && node.intersects(operation.getOutput())) return false;
        }
        return false;
    }

    private static boolean isConstant(Varnode node, long value) {
        return node.isConstant() && signedConstant(node) == value;
    }

    private static Instruction epilogueReturn(Program program, Function function, Address start,
            Register eax, boolean preserveEax, TaskMonitor monitor) throws Exception {
        Set<Address> visited = new HashSet<>();
        Address address = start;
        for (int count = 0; count < EPILOGUE_INSTRUCTIONS && address != null && visited.add(address); count++) {
            monitor.checkCancelled();
            Function entry = program.getFunctionManager().getFunctionAt(address);
            if (entry != null && !entry.equals(function)) return null; // A separate entry can be a tail call.
            Instruction item = program.getListing().getInstructionAt(address);
            if (item == null) return null;
            if (isReturn(item)) return item;
            if (preserveEax && writesRegister(item, eax)) return null;
            if (item.getFlowType().isJump() && !item.getFlowType().isConditional() && !item.getFlowType().isComputed()) {
                Address[] targets = item.getFlows();
                if (targets.length != 1) return null;
                address = targets[0];
                continue;
            }
            if (item.getFlowType().isCall() || item.getFlowType().isJump() || item.getFlowType().isTerminal()) return null;
            String mnemonic = item.getMnemonicString().toUpperCase(Locale.ROOT);
            if (!Set.of("POP", "LEAVE", "NOP").contains(mnemonic) &&
                !(Set.of("ADD", "MOV").contains(mnemonic) && item.getRegister(0) != null &&
                  item.getRegister(0).getName().equals("ESP"))) return null;
            address = item.getFallThrough();
        }
        return null;
    }

    private static void cleanupDiagnostic(Instruction returned, Instruction branch, long extent,
            FunctionPrototype prototype, Long expectedCleanup, String claim, JsonArray diagnostics, Set<Address> reported,
            java.util.function.Function<Address, String> addressText) {
        if (!reported.add(returned.getAddress()) || !returned.getMnemonicString().equalsIgnoreCase("RET")) return;
        long cleanup = returned.getNumOperands() == 0 || returned.getScalar(0) == null ? 0 : returned.getScalar(0).getUnsignedValue();
        // Known caller-cleaned models require zero argument cleanup even when
        // the observed immediate happens to equal recovered parameter storage.
        // UNKNOWN_EXTRAPOP is not proof that the callee owns cleanup.
        if (expectedCleanup != null ? cleanup == expectedCleanup :
                prototype.isVarArg() || cleanup == extent) return;
        JsonArray facts = new JsonArray();
        if (branch != null) facts.add(evidence("branch", branch, "Direct branch to a shared epilogue outside the owned body; no body range was added.", addressText));
        facts.add(evidence("return", returned, "RET explicitly cleans up " + cleanup + " bytes, compared with " + extent + " recovered stack-argument bytes." +
            (expectedCleanup == null ? " Compiler-model cleanup is unknown." : " The compiler model requires " + expectedCleanup + " argument-cleanup bytes."), addressText));
        diagnostics.add(diagnostic("stack-cleanup", expectedCleanup == null ? "observation" : "conflict", claim, facts,
            "Hidden parameters, stack padding, custom calling conventions and incomplete parameter recovery remain possible. Cleanup bytes do not prove a source argument count."));
    }

    private static JsonObject evidence(String kind, Instruction instruction, String detail,
            java.util.function.Function<Address, String> addressText) {
        JsonObject result = new JsonObject();
        result.addProperty("kind", kind);
        result.addProperty("address", addressText.apply(instruction.getAddress()));
        result.addProperty("detail", detail);
        return result;
    }

    private static JsonObject diagnostic(String kind, String classification, String claim,
            JsonArray evidence, String unknown) {
        JsonObject result = new JsonObject();
        result.addProperty("kind", kind);
        result.addProperty("classification", classification);
        result.addProperty("inferred_claim", claim);
        result.add("evidence", evidence);
        JsonArray unknowns = new JsonArray();
        unknowns.add(unknown);
        result.add("residual_unknowns", unknowns);
        return result;
    }
}
