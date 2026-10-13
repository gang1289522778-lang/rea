import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { JavaArchivePort } from "../application/java/JavaArchivePort.js";
import type {
  JavaClassSelectionInput,
  InspectJavaArchiveInput,
} from "../domain/java/javaArchive.js";
import { JavaClassFileProvider } from "./JavaClassFileProvider.js";
import { VineflowerDecompiler } from "./VineflowerDecompiler.js";

/** Bundled class-file reading plus the optional caller-supplied decompiler. */
export class JavaArchiveProvider implements JavaArchivePort {
  readonly #reader: JavaClassFileProvider;
  readonly #decompiler: VineflowerDecompiler;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
    decompiler: VineflowerDecompiler = new VineflowerDecompiler(environment),
  ) {
    this.#reader = new JavaClassFileProvider();
    this.#decompiler = decompiler;
  }

  get identities() {
    return {
      classFile: this.#reader.identity,
      decompiler: this.#decompiler.identity,
    };
  }

  close(): Promise<void> {
    return this.#decompiler.close();
  }

  inspectArchive(input: InspectJavaArchiveInput, options?: ExecutionOptions) {
    return this.#reader.inspectArchive(input, options);
  }

  inspectClass(input: JavaClassSelectionInput, options?: ExecutionOptions) {
    return this.#reader.inspectClass(input, options);
  }

  decompile(input: JavaClassSelectionInput, options?: ExecutionOptions) {
    return this.#decompiler.decompile(input, options);
  }
}
