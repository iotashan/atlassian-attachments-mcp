export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class AtlassianApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AtlassianApiError";
  }
}

export class SandboxViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxViolationError";
  }
}

export class FileExistsError extends Error {
  constructor(
    readonly path: string,
    readonly suggestedPath: string,
  ) {
    super(
      `File already exists: ${path}. Pass overwrite:true to replace it, or use the suggested path: ${suggestedPath}`,
    );
    this.name = "FileExistsError";
  }
}
