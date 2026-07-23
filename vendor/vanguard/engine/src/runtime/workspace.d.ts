export declare class WorkspaceBoundary {
    #private;
    readonly root: string;
    constructor(root: string);
    lexical(relativePath: string): string;
    existing(relativePath: string): Promise<string>;
    writable(relativePath: string): Promise<string>;
    /**
     * The workspace-relative spelling of a requested path. Contained absolutes
     * relativize so version ledgers and policy checks key one spelling per
     * file; relative requests pass through untouched.
     */
    relativize(requested: string): string;
}
