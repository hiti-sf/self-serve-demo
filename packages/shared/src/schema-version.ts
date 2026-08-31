/**
 * Manifest schema versioning.
 *
 * The player refuses manifests whose MAJOR version exceeds what it supports (§4).
 * A newer MINOR version is accepted: minor bumps may only add optional fields.
 */

export const SUPPORTED_SCHEMA_VERSION = '1.0';

export interface ParsedSchemaVersion {
  major: number;
  minor: number;
}

export class SchemaVersionError extends Error {
  readonly found: string;
  readonly supported: string;

  constructor(message: string, found: string, supported: string = SUPPORTED_SCHEMA_VERSION) {
    super(message);
    this.name = 'SchemaVersionError';
    this.found = found;
    this.supported = supported;
  }
}

export function parseSchemaVersion(value: string): ParsedSchemaVersion {
  const match = /^(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) {
    throw new SchemaVersionError(
      `Malformed schemaVersion "${value}". Expected "<major>.<minor>", e.g. "1.0".`,
      value,
    );
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Throws a human-readable SchemaVersionError when the manifest cannot be rendered.
 * Callers should surface `error.message` verbatim — a silent mis-render in front of
 * a prospect is worse than a hard stop.
 */
export function assertSupportedSchemaVersion(
  found: string,
  supported: string = SUPPORTED_SCHEMA_VERSION,
): void {
  const wanted = parseSchemaVersion(found);
  const have = parseSchemaVersion(supported);

  if (wanted.major > have.major) {
    throw new SchemaVersionError(
      `This demo was authored for manifest schema ${found}, but this player supports ${supported}. ` +
        `Update the player, or re-export the demo from the editor at schema ${supported}.`,
      found,
      supported,
    );
  }
  if (wanted.major < have.major) {
    throw new SchemaVersionError(
      `Demo manifest schema ${found} is no longer supported by this player (${supported}). ` +
        `Re-export the demo from the editor.`,
      found,
      supported,
    );
  }
}

export function isSupportedSchemaVersion(found: string): boolean {
  try {
    assertSupportedSchemaVersion(found);
    return true;
  } catch {
    return false;
  }
}
