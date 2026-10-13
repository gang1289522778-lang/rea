//@category REA Verification
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import com.google.gson.JsonObject;
import com.google.gson.JsonElement;
import generic.jar.ResourceFile;
import ghidra.app.script.GhidraScript;
import ghidra.app.script.GhidraScriptUtil;
import ghidra.app.decompiler.DecompInterface;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.ParameterImpl;
import ghidra.program.model.listing.ReturnParameterImpl;
import ghidra.program.model.data.CharDataType;
import ghidra.program.model.data.IntegerDataType;
import ghidra.program.model.data.VoidDataType;
import ghidra.program.model.data.TypedefDataType;
import ghidra.program.model.data.PointerDataType;
import ghidra.program.model.data.Undefined4DataType;
import ghidra.program.model.listing.FlowOverride;
import ghidra.program.model.symbol.SourceType;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.pcode.HighFunctionDBUtil;
import ghidra.program.model.pcode.HighFunctionDBUtil.ReturnCommitOption;

/** Runs the actual dossier producer on an imported source-owned ELF32 oracle.
 * No target instructions execute. Reported native types are not the oracle.
 */
public class ReaPrototypeDiagnosticsProbe extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 2) throw new IllegalArgumentException("Expected exact bridge source and output JSON paths");
        ResourceFile source = GhidraScriptUtil.findScriptByName("ReaGhidraBridge.java");
        if (source == null || !new File(source.getAbsolutePath()).getCanonicalFile().equals(new File(args[0]).getCanonicalFile()))
            throw new IllegalStateException("Production bridge source resolution mismatch");
        GhidraScript bridge = GhidraScriptUtil.getProvider(source).getScriptInstance(source, errorWriter);
        bridge.set(getState(), getControls());
        Field space = bridge.getClass().getDeclaredField("sessionDefaultAddressSpace");
        space.setAccessible(true);
        space.set(null, currentProgram.getAddressFactory().getDefaultAddressSpace());
        Method initialize = bridge.getClass().getDeclaredMethod("initializeDecompiler");
        initialize.setAccessible(true);
        initialize.invoke(bridge);
        Field decompilerField = bridge.getClass().getDeclaredField("decompiler");
        decompilerField.setAccessible(true);
        DecompInterface decompiler = (DecompInterface) decompilerField.get(bridge);
        seedControls(decompiler);
        decompiler.flushCache();
        Method analyze = bridge.getClass().getDeclaredMethod("analyzeFunctionObservation", JsonObject.class);
        analyze.setAccessible(true);
        Method envelope = bridge.getClass().getDeclaredMethod("functionObservation", JsonElement.class, java.util.List.class);
        envelope.setAccessible(true);
        JsonObject report = new JsonObject();
        report.addProperty("scope", "Actual production dossier producer on source-owned x86-32 instructions imported with the Windows compiler model; selected ephemeral function metadata is seeded for prototype omissions, ABI padding, signature provenance and shared ownership controls. Target instructions are never executed. This does not verify a Windows host or launcher.");
        if (!currentProgram.getCompilerSpec().getCompilerSpecID().toString().equals("windows"))
            throw new IllegalStateException("The seeded stdcall controls require the actual x86 Windows compiler model");
        try {
            FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
            while (functions.hasNext()) {
                monitor.checkCancelled();
                Function function = functions.next();
                if (!function.getName().startsWith("rea_")) continue;
                JsonObject request = new JsonObject();
                request.addProperty("procedure", "0x" + Long.toHexString(function.getEntryPoint().getOffset()));
                String body = function.getBody().toString();
                JsonObject entry = new JsonObject();
                entry.addProperty("owned_body_before", body);
                Object analyzed = analyze.invoke(bridge, request);
                Method dossier = analyzed.getClass().getDeclaredMethod("dossier");
                Method limitations = analyzed.getClass().getDeclaredMethod("limitations");
                dossier.setAccessible(true);
                limitations.setAccessible(true);
                JsonObject wire = (JsonObject) envelope.invoke(bridge, dossier.invoke(analyzed), limitations.invoke(analyzed));
                entry.add("wire_observation", wire);
                entry.add("dossier", wire.getAsJsonObject("value"));
                entry.addProperty("owned_body_after", function.getBody().toString());
                report.add(function.getName(), entry);
            }
            Files.writeString(Path.of(args[1]), report.toString());
            println("REA_PROTOTYPE_DIAGNOSTICS_PROBE_COMPLETE");
        } finally { decompiler.dispose(); }
    }

    private void seedControls(DecompInterface decompiler) throws Exception {
        FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
        while (functions.hasNext()) {
            Function function = functions.next();
            if (!function.getName().startsWith("rea_")) continue;
            function.setCallingConvention("__cdecl");
            // Retain naturally recovered parameters before applying analysis provenance.
            var recovered = decompiler.decompileFunction(function, 60, monitor);
            if (recovered.getHighFunction() == null) throw new IllegalStateException("Missing control HighFunction");
            HighFunctionDBUtil.commitParamsToDatabase(recovered.getHighFunction(), true,
                ReturnCommitOption.COMMIT, SourceType.ANALYSIS);
            function.setSignatureSource(SourceType.ANALYSIS);
            if (java.util.Set.of("rea_written_slot_control", "rea_unknown_store_control", "rea_conditional_pointer_control", "rea_dynamic_stack_control", "rea_userop_control", "rea_long_entry_prefix").contains(function.getName()))
                function.updateFunction("__cdecl", new ReturnParameterImpl(VoidDataType.dataType, currentProgram),
                    Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.ANALYSIS);
            if (java.util.Set.of("rea_forward_clear_xor", "rea_forward_clear_sub", "rea_forward_clear_and", "rea_forward_clear_test", "rea_many_forwarding").contains(function.getName()))
                function.updateFunction("__cdecl", new ReturnParameterImpl(VoidDataType.dataType, currentProgram),
                    Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.ANALYSIS);
            if (function.getName().equals("rea_cleanup_conflict") || function.getName().equals("rea_cleanup_control"))
                function.setCallingConvention("__stdcall");
            if (function.getName().equals("rea_named_undefined_return"))
                function.updateFunction("__cdecl", new ReturnParameterImpl(new TypedefDataType("undefined_status", IntegerDataType.dataType), currentProgram),
                    Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.USER_DEFINED);
            if (function.getName().equals("rea_undefined_pointer_return"))
                function.updateFunction("__cdecl", new ReturnParameterImpl(new PointerDataType(Undefined4DataType.dataType), currentProgram),
                    Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.USER_DEFINED);
            if (function.getName().equals("rea_cdecl_cleanup_conflict"))
                function.updateFunction("__cdecl", new ReturnParameterImpl(IntegerDataType.dataType, currentProgram),
                    Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.USER_DEFINED,
                    new ParameterImpl("input", IntegerDataType.dataType, currentProgram));
            if (function.getName().equals("rea_padding_control"))
                function.updateFunction("__stdcall", new ReturnParameterImpl(IntegerDataType.dataType, currentProgram),
                    Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.USER_DEFINED,
                    new ParameterImpl("byte_input", CharDataType.dataType, currentProgram));
            if (function.getName().equals("rea_stdcall_missing_cleanup"))
                function.updateFunction("__stdcall", new ReturnParameterImpl(IntegerDataType.dataType, currentProgram),
                    Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.USER_DEFINED,
                    new ParameterImpl("input", IntegerDataType.dataType, currentProgram));
            if (function.getName().equals("rea_fastcall_missing_cleanup"))
                function.updateFunction("__fastcall", new ReturnParameterImpl(IntegerDataType.dataType, currentProgram),
                    Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.USER_DEFINED,
                    new ParameterImpl("register_a", IntegerDataType.dataType, currentProgram),
                    new ParameterImpl("register_b", IntegerDataType.dataType, currentProgram),
                    new ParameterImpl("stack_input", IntegerDataType.dataType, currentProgram));
            if (function.getName().equals("rea_thiscall_missing_cleanup"))
                function.updateFunction("__thiscall", new ReturnParameterImpl(IntegerDataType.dataType, currentProgram),
                    Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.USER_DEFINED,
                    new ParameterImpl("stack_input", IntegerDataType.dataType, currentProgram));
            if (function.getName().equals("rea_custom_allocation_control"))
                function.updateFunction("__cdecl", new ReturnParameterImpl(IntegerDataType.dataType, currentProgram),
                    Function.FunctionUpdateType.CUSTOM_STORAGE, true, SourceType.USER_DEFINED,
                    new ParameterImpl("byte_input", CharDataType.dataType, 4, currentProgram));
            if (java.util.Set.of("rea_variadic_control", "rea_variadic_cleanup_conflict").contains(function.getName())) {
                function.updateFunction("__cdecl", new ReturnParameterImpl(IntegerDataType.dataType, currentProgram),
                    Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.USER_DEFINED,
                    new ParameterImpl("fixed_input", IntegerDataType.dataType, currentProgram));
                function.setVarArgs(true);
            }
            if (function.getName().equals("rea_shared_cleanup")) {
                SymbolIterator symbols = currentProgram.getSymbolTable().getSymbols("rea_shared_return");
                if (!symbols.hasNext()) throw new IllegalStateException("Missing shared return oracle");
                Symbol returned = symbols.next();
                Function accidentalEntry = currentProgram.getFunctionManager().getFunctionAt(returned.getAddress());
                if (accidentalEntry != null) currentProgram.getFunctionManager().removeFunction(returned.getAddress());
                function.setBody(new AddressSet(function.getEntryPoint(), returned.getAddress().subtract(1)));
                function.setNoReturn(false);
                function.updateFunction("__stdcall", new ReturnParameterImpl(IntegerDataType.dataType, currentProgram),
                    Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.ANALYSIS,
                    new ParameterImpl("a", IntegerDataType.dataType, currentProgram),
                    new ParameterImpl("b", IntegerDataType.dataType, currentProgram),
                    new ParameterImpl("c", IntegerDataType.dataType, currentProgram),
                    new ParameterImpl("d", IntegerDataType.dataType, currentProgram));
                currentProgram.getListing().getInstructionBefore(returned.getAddress()).setFlowOverride(FlowOverride.NONE);
            }
        }
    }
}
