import { JavaArchiveService } from "../application/java/JavaArchiveService.js";
import { JavaArchiveProvider } from "../java/JavaArchiveProvider.js";

/** Compose bundled class-file reading and the optional caller-supplied decompiler without import-time I/O. */
export const createJavaArchiveService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): JavaArchiveService =>
  new JavaArchiveService(new JavaArchiveProvider(environment));
