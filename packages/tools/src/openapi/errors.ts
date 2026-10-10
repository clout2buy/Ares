// Shared by call.ts and connectedToken.ts (which would otherwise import each other).

/** A problem with how the model called: the message says how to fix it. */
export class ApiInputError extends Error {}

export interface CredentialSource {
  get(name: string): Promise<string | undefined>;
}
